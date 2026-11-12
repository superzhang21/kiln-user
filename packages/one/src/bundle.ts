import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { KilnError, issue, type Issue } from "#grain";
import { discoverCastDirs } from "#pact";
import { OneIssues } from "./errors.ts";
import type { UpConfig } from "./types.ts";

const ROOT_FILES = ["AGENT.md", "up.json", "README.md", "kiln-up.mjs", "kiln-up.cmd", "kiln-up.sh"] as const;
const CHECKSUM_FILE = "checksums.json";
const POLICIES = new Set(["strict", "local", "relaxed"]);

export interface Checksums {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly algorithm: "sha256";
  readonly bundle: string;
  readonly files: Record<string, string>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function resolveBundleDir(input?: string): string {
  const raw = input ?? process.env.KILN_ONE_BUNDLE ?? path.resolve(process.cwd(), "one");
  return path.resolve(raw);
}

export function resolveRuntimeRoot(bundleDir: string, explicit?: string): string {
  return path.resolve(explicit ?? process.env.KILN_HOME ?? path.resolve(bundleDir, ".."));
}

export function cliPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "packages", "surface", "src", "cli.ts");
}

export function statePath(bundleDir: string): string {
  return path.join(bundleDir, ".kiln", "state", "one-state.json");
}

export function portableConfigPath(bundleDir: string): string {
  return path.join(bundleDir, ".mcp.json");
}

/** 一键包不自带内核，KILN_HOME 可显式指向仓库。 */
export async function assertRuntime(runtimeRoot: string, nodeVersion = process.versions.node): Promise<string> {
  const parts = nodeVersion.split(".");
  const major = Number(parts[0] ?? 0);
  const minor = Number(parts[1] ?? 0);
  if (!(major > 22 || (major === 22 && minor >= 18))) {
    throw new KilnError({
      code: "KILN_ONE_RUNTIME",
      message: `Node 版本过低: ${nodeVersion}，需要 >=22.18`,
      detail: { node: nodeVersion, requires: ">=22.18" },
    });
  }
  try {
    await stat(cliPath(runtimeRoot));
  } catch {
    throw new KilnError({
      code: "KILN_ONE_RUNTIME",
      message: `找不到 kiln 运行时: ${cliPath(runtimeRoot)}`,
      hint: "设置 KILN_HOME 指向 kiln 仓库根目录，或把一键包放在仓库内的 one/ 目录。",
      detail: { runtimeRoot },
    });
  }
  return nodeVersion;
}

/** 所有问题一次返回，不在第一处中止。 */
export async function readUpConfig(bundleDir: string): Promise<UpConfig> {
  const file = path.join(bundleDir, "up.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new KilnError({
      code: "KILN_ONE_BUNDLE",
      message: `读不到或解析失败: ${file}`,
      detail: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
  if (!isRecord(raw)) {
    throw new KilnError({ code: "KILN_ONE_BUNDLE", message: "up.json 根必须是对象", detail: { file } });
  }

  const problems: Issue[] = [];
  const add = (field: string, message: string) =>
    problems.push(
      issue({ code: "KILN_ONE_BUNDLE", message, hint: `修正 up.json 的 ${field} 字段。`, detail: { file, field } }),
    );
  const text = (key: string): string | null => {
    const value = raw[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };

  if (raw.schemaVersion !== 1) add("schemaVersion", "schemaVersion 必须为 1");
  if (!text("id")) add("id", "缺少 id");
  if (!text("version")) add("version", "缺少 version");
  if (!text("title")) add("title", "缺少 title");

  const appsDir = text("appsDir");
  if (!appsDir) add("appsDir", "缺少 appsDir");
  else if (appsDir.includes("..") || path.isAbsolute(appsDir)) add("appsDir", "appsDir 必须是包内相对路径");

  const dataDir = text("dataDir");
  if (!dataDir) add("dataDir", "缺少 dataDir");
  else if (dataDir.includes("..") || path.isAbsolute(dataDir)) add("dataDir", "dataDir 必须是包内相对路径");

  const policy = text("policy");
  if (!policy || !POLICIES.has(policy)) add("policy", "policy 只能是 strict / local / relaxed");
  if (typeof raw.autostart !== "boolean") add("autostart", "autostart 必须是布尔值");

  if (raw.clients !== "auto" && raw.clients !== "none" && !Array.isArray(raw.clients)) {
    add("clients", "clients 只能是 auto / none / 字符串数组");
  }
  if (Array.isArray(raw.clients) && raw.clients.some((item) => typeof item !== "string")) {
    add("clients", "clients 数组里只能有字符串");
  }

  const handshake = isRecord(raw.handshake) ? raw.handshake : null;
  if (!handshake) add("handshake", "缺少 handshake 对象");
  else {
    const timeout = handshake.timeoutMs;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1000 || timeout > 120_000) {
      add("handshake.timeoutMs", "timeoutMs 必须是 1000..120000 的整数");
    }
    if (typeof handshake.probeTool !== "string" || handshake.probeTool.trim() === "") {
      add("handshake.probeTool", "缺少只读自检工具名");
    }
    if (typeof handshake.describeTool !== "string" || handshake.describeTool.trim() === "") {
      add("handshake.describeTool", "缺少 describe 工具名");
    }
    if (typeof handshake.protocolVersion !== "string" || handshake.protocolVersion.trim() === "") {
      add("handshake.protocolVersion", "缺少 MCP 协议版本");
    }
  }

  if (!Array.isArray(raw.permissions) || raw.permissions.length === 0) {
    add("permissions", "permissions 必须是非空数组");
  } else {
    for (const [index, entry] of raw.permissions.entries()) {
      if (!isRecord(entry) || typeof entry.human !== "string" || typeof entry.capability !== "string") {
        add(`permissions[${index}]`, "每项必须有 capability 与 human 字段");
      }
    }
  }

  if (problems.length > 0) throw new OneIssues(problems);
  return raw as unknown as UpConfig;
}

async function walk(dir: string, prefix: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const relative = `${prefix}/${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, relative, out);
    else if (entry.isFile()) out.push(relative);
  }
}

/** 只 seal 固定根文件与应用源码；运行时数据、连接配置、校验清单自身一律排除。 */
export async function sealedFiles(bundleDir: string, appsDir = "apps"): Promise<string[]> {
  const out: string[] = [];
  for (const name of ROOT_FILES) {
    try {
      if ((await stat(path.join(bundleDir, name))).isFile()) out.push(name);
    } catch {
      /* 可选文件：不存在就跳过 */
    }
  }
  try {
    const apps = path.join(bundleDir, appsDir);
    if ((await stat(apps)).isDirectory()) await walk(apps, appsDir, out);
  } catch {
    /* 目录不存在时，交由后续加载步骤报错 */
  }
  return out.sort();
}

/** 流式哈希：大文件不进内存。 */
export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function sealBundle(bundleDir: string): Promise<Checksums> {
  const config = await readUpConfig(bundleDir);
  const files = await sealedFiles(bundleDir, config.appsDir);
  const record: Record<string, string> = {};
  for (const relative of files) {
    record[relative] = await hashFile(path.join(bundleDir, ...relative.split("/")));
  }
  const sums: Checksums = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    algorithm: "sha256",
    bundle: `${config.id}@${config.version}`,
    files: record,
  };
  await writeFile(path.join(bundleDir, CHECKSUM_FILE), `${JSON.stringify(sums, null, 2)}\n`, "utf8");
  return sums;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly issues: readonly Issue[];
  readonly files: number;
}

/** 缺失、篡改、未登记的应用文件，一次全部报出。 */
export async function verifyBundle(bundleDir: string): Promise<VerifyResult> {
  const config = await readUpConfig(bundleDir);
  const issues: Issue[] = [];
  const sumsPath = path.join(bundleDir, CHECKSUM_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(sumsPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      issues: [
        issue({
          code: "KILN_ONE_INTEGRITY",
          message: `读不到完整性清单: ${sumsPath}`,
          hint: "运行 `kiln seal <bundle>` 重新生成 checksums.json；不要从未经验证的来源复制包。",
          detail: { cause: error instanceof Error ? error.message : String(error) },
        }),
      ],
      files: 0,
    };
  }

  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.algorithm !== "sha256" || !isRecord(raw.files)) {
    return {
      ok: false,
      issues: [
        issue({
          code: "KILN_ONE_INTEGRITY",
          message: "checksums.json 结构不合规",
          hint: "运行 `kiln seal <bundle>` 重新生成完整性清单。",
          detail: { file: sumsPath },
        }),
      ],
      files: 0,
    };
  }
  const declared = raw.files as Record<string, unknown>;
  const actual = await sealedFiles(bundleDir, config.appsDir);
  const actualSet = new Set(actual);

  if (raw.bundle !== `${config.id}@${config.version}`) {
    issues.push(
      issue({
        code: "KILN_ONE_INTEGRITY",
        message: "清单里的包版本与 up.json 不一致",
        hint: "运行 `kiln seal <bundle>` 重新生成完整性清单。",
        detail: { expected: `${config.id}@${config.version}`, actual: raw.bundle },
      }),
    );
  }
  for (const relative of Object.keys(declared)) {
    if (!actualSet.has(relative)) {
      issues.push(
        issue({
          code: "KILN_ONE_INTEGRITY",
          message: `完整性清单中的文件缺失: ${relative}`,
          detail: { file: relative },
        }),
      );
    }
  }
  for (const relative of actual) {
    const expected = declared[relative];
    if (typeof expected !== "string") {
      issues.push(
        issue({
          code: "KILN_ONE_INTEGRITY",
          message: `发现未登记的文件: ${relative}`,
          hint: "新增或修改应用源码后必须运行 `kiln seal <bundle>`；不要运行未审阅的代码。",
          detail: { file: relative },
        }),
      );
      continue;
    }
    const found = await hashFile(path.join(bundleDir, ...relative.split("/")));
    if (found !== expected) {
      issues.push(
        issue({
          code: "KILN_ONE_INTEGRITY",
          message: `文件校验失败（可能被修改）: ${relative}`,
          hint: "确认改动来自你自己后运行 `kiln seal <bundle>`；否则换回原始一键包。",
          detail: { file: relative, expected, found },
        }),
      );
    }
  }
  return { ok: issues.length === 0, issues, files: actual.length };
}

export async function appDirs(bundleDir: string, config: UpConfig): Promise<string[]> {
  return await discoverCastDirs(path.join(bundleDir, config.appsDir), 4);
}
