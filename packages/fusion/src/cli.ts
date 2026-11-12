import { readFile } from "node:fs/promises";
import path from "node:path";
import { KilnError } from "#grain";
import {
  buildArtifact,
  verifyArtifact,
  writeArtifact,
  readArtifact,
  importArtifact,
  generateKeypair,
  loadPublicKeys,
  resignArtifact,
} from "./artifact.ts";
import {
  initCast,
  checkCast,
  hostInstall,
  hostList,
  hostApprove,
  hostDeny,
  hostEnable,
  hostDisable,
  hostRun,
  hostPanel,
  hostUpdate,
  hostUninstall,
} from "./adapters.ts";
import { startMcpHttp } from "./bridge.ts";
import { runFusionEval } from "./eval.ts";
import { CAST_TEMPLATES, scaffoldCastProject, type CastTemplate } from "./scaffold.ts";
import { readAudit } from "./security.ts";
import { defaultAppsHome, installPackage, listInstalled, readAnyArtifact, uninstallApp, writePackage } from "./pack.ts";
import { runSandboxed } from "./sandbox.ts";
import { buildSemanticIndex, semanticSearch } from "./semantic.ts";

type Values = Record<string, string | boolean | undefined>;

function required(value: string | undefined, label: string): string {
  if (!value)
    throw new KilnError({
      code: "KILN_FUSION_ARTIFACT",
      message: `缺少${label}`,
      hint: "用 kiln --help 查看命令用法。",
    });
  return value;
}

function text(values: Values, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function flag(values: Values, key: string): boolean {
  return values[key] === true;
}

function jsonArgs(values: Values): Record<string, unknown> {
  const raw = text(values, "args");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("不是对象");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new KilnError({
      code: "KILN_FUSION_ARTIFACT",
      message: "--args 必须是 JSON 对象",
      detail: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

function keysDir(values: Values): string {
  return path.resolve(text(values, "key-dir") ?? path.join(process.cwd(), ".kiln", "keys"));
}

async function privateKeyOf(values: Values): Promise<{ privateKey: string; keyId: string } | undefined> {
  const keyId = text(values, "key");
  if (!keyId) return undefined;
  const file = path.join(keysDir(values), `${keyId}.private.pem`);
  try {
    return { keyId, privateKey: await readFile(file, "utf8") };
  } catch {
    throw new KilnError({
      code: "KILN_FUSION_SIGNATURE",
      message: `找不到私钥：${file}`,
      hint: "先运行 kiln keygen <目录> 生成密钥，并用 --key-dir 指定同一目录。",
    });
  }
}

export async function artifactCommand(
  action: string | undefined,
  target: string | undefined,
  values: Values,
): Promise<Record<string, unknown>> {
  const name = required(action, "操作（build / verify / import / sign）");
  const file = required(target, "路径");
  if (name === "build") {
    const sign = await privateKeyOf(values);
    const built = await buildArtifact(file, sign ? { sign } : {});
    const out = path.resolve(text(values, "out") ?? `./${built.artifact.id}@${built.artifact.version}.kiln`);
    // .kiln 走 gzip 容器；.json 保留可读的自描述格式。
    if (out.endsWith(".kiln")) await writePackage(out, built.artifact);
    else await writeArtifact(out, built.artifact);
    return {
      ok: true,
      command: "artifact",
      action: name,
      file: out,
      bytes: built.bytes,
      digest: built.digest,
      signed: Boolean(sign),
    };
  }
  if (name === "verify") {
    const result = await verifyArtifact(await readAnyArtifact(file), {
      publicKeys: await loadPublicKeys(keysDir(values)),
      requireSignature: flag(values, "require-signature"),
    });
    return { ok: result.ok, command: "artifact", action: name, issues: result.issues, digest: result.digest };
  }
  if (name === "import") {
    const out = required(text(values, "out"), "输出目录（--out）");
    const dir = await importArtifact(file, out);
    return { ok: true, command: "artifact", action: name, dir };
  }
  if (name === "sign") {
    const sign = await privateKeyOf(values);
    if (!sign) throw new KilnError({ code: "KILN_FUSION_SIGNATURE", message: "签名需要 --key <keyId>" });
    const signed = resignArtifact(await readAnyArtifact(file), sign);
    if (file.endsWith(".kiln")) await writePackage(file, signed);
    else await writeArtifact(file, signed);
    return { ok: true, command: "artifact", action: name, file, keyId: sign.keyId };
  }
  throw new KilnError({ code: "KILN_FUSION_ARTIFACT", message: `未知的 artifact 操作：${name}` });
}

export async function keygenCommand(dir: string | undefined, values: Values): Promise<Record<string, unknown>> {
  const target = path.resolve(text(values, "key-dir") ?? dir ?? path.join(process.cwd(), ".kiln", "keys"));
  const keys = await generateKeypair(target);
  return {
    ok: true,
    command: "keygen",
    keyId: keys.keyId,
    publicKeyFile: keys.files.publicKey,
    privateKeyFile: keys.files.privateKey,
  };
}

export async function newCommand(dir: string | undefined, values: Values): Promise<Record<string, unknown>> {
  const project = required(dir, "项目目录");
  const templateRaw = text(values, "template") ?? "minimal";
  if (!(CAST_TEMPLATES as readonly string[]).includes(templateRaw)) {
    throw new KilnError({
      code: "KILN_USAGE",
      message: `未知模板: ${templateRaw}`,
      hint: `可选模板：${CAST_TEMPLATES.join(" / ")}`,
    });
  }
  const result = await scaffoldCastProject({
    dir: project,
    template: templateRaw as CastTemplate,
    force: flag(values, "force"),
    ...(text(values, "name") ? { id: text(values, "name")! } : {}),
    ...(text(values, "title") ? { title: text(values, "title")! } : {}),
  });
  return {
    ok: true,
    command: "new",
    template: result.template,
    root: result.root,
    castDir: result.castDir,
    files: result.files,
    next: [
      `kiln check ${result.castDir}`,
      `kiln describe ${result.castDir}`,
      `kiln mcp ${result.castDir}`,
      `kiln serve ${result.castDir} --port 4312`,
    ].map((line) => line.split(path.sep).join("/")),
  };
}

export async function castCommand(
  action: string | undefined,
  dir: string | undefined,
  values: Values,
): Promise<Record<string, unknown>> {
  const project = required(dir, "cast 项目目录");
  if (action === "init") {
    const result = await initCast(project, { ...(text(values, "name") ? { id: text(values, "name") } : {}) });
    return {
      ok: true,
      command: "cast",
      action,
      castDir: result.castDir,
      files: result.files,
    };
  }
  if (action === "check") {
    const result = await checkCast(project);
    return { ok: result.ok, command: "cast", action, issues: result.issues, castDir: result.castDir };
  }
  throw new KilnError({ code: "KILN_FUSION_CAST", message: `未知的 cast 操作：${action ?? "空"}` });
}

export async function hostCommand(
  action: string | undefined,
  target: string | undefined,
  values: Values,
): Promise<Record<string, unknown>> {
  const name = required(action, "宿主操作");
  const workspace = path.resolve(text(values, "workspace") ?? process.cwd());
  const tenant = text(values, "tenant") ?? "default";
  const publicKeys = await loadPublicKeys(keysDir(values));
  const installOptions = { tenant, publicKeys, requireSignature: flag(values, "require-signature") };
  switch (name) {
    case "install":
      return {
        ok: true,
        command: "host",
        action: name,
        app: await hostInstall(required(target, "artifact 路径"), workspace, installOptions),
      };
    case "update":
      return {
        ok: true,
        command: "host",
        action: name,
        app: await hostUpdate(required(target, "artifact 路径"), workspace, installOptions),
      };
    case "list":
      return { ok: true, command: "host", action: name, apps: await hostList(workspace, tenant) };
    case "approve":
      return {
        ok: true,
        command: "host",
        action: name,
        app: await hostApprove(workspace, required(target, "应用 id"), { tenant, by: text(values, "by") }),
      };
    case "deny":
      return {
        ok: true,
        command: "host",
        action: name,
        app: await hostDeny(workspace, required(target, "应用 id"), { tenant, reason: text(values, "reason") }),
      };
    case "enable":
      return {
        ok: true,
        command: "host",
        action: name,
        app: await hostEnable(workspace, required(target, "应用 id"), tenant),
      };
    case "disable":
      return {
        ok: true,
        command: "host",
        action: name,
        app: await hostDisable(workspace, required(target, "应用 id"), tenant),
      };
    case "uninstall":
      return {
        ok: true,
        command: "host",
        action: name,
        ...(await hostUninstall(workspace, required(target, "应用 id"), tenant)),
      };
    case "panel":
      return {
        ok: true,
        command: "host",
        action: name,
        panel: await hostPanel(workspace, required(target, "应用 id"), tenant),
      };
    case "audit":
      return { ok: true, command: "host", action: name, events: await readAudit(workspace) };
    case "run": {
      const verb = text(values, "verb") ?? "invoke";
      if (verb !== "invoke" && verb !== "observe" && verb !== "act") {
        throw new KilnError({
          code: "KILN_FUSION_HOST",
          message: `--verb 只能是 invoke / observe / act，收到 ${verb}`,
        });
      }
      const result = await hostRun(workspace, required(target, "应用 id"), {
        tenant,
        verb,
        name: text(values, "name") ?? "",
        args: jsonArgs(values),
        isolated: flag(values, "isolated"),
      });
      return { ok: true, command: "host", action: name, result };
    }
    default:
      throw new KilnError({ code: "KILN_FUSION_HOST", message: `未知的宿主操作：${name}` });
  }
}

export async function discoverCommand(query: string | undefined, values: Values): Promise<Record<string, unknown>> {
  const dir = path.resolve(text(values, "dir") ?? text(values, "workspace") ?? ".");
  const { discoverCastDirs } = await import("#pact");
  const dirs = await discoverCastDirs(dir, 4);
  const index = await buildSemanticIndex(dirs);
  const topK = Math.min(20, Math.max(1, Number(text(values, "limit") ?? 5)));
  const hits = semanticSearch(index, required(query, "检索词"), topK);
  return {
    ok: true,
    command: "discover",
    query,
    mode: "semantic",
    dirs: dirs.length,
    hits: hits.map((hit) => ({
      id: hit.entry.id,
      score: Number(hit.score.toFixed(4)),
      lexical: Number(hit.lexical.toFixed(2)),
      dir: hit.entry.dir,
    })),
  };
}

export async function installCommand(source: string | undefined, values: Values): Promise<Record<string, unknown>> {
  const home = path.resolve(text(values, "home") ?? defaultAppsHome());
  const installed = await installPackage(required(source, "安装包路径或 URL"), {
    home,
    publicKeys: await loadPublicKeys(keysDir(values)),
    requireSignature: flag(values, "require-signature"),
  });
  return {
    ok: true,
    command: "install",
    home,
    app: installed.app,
    files: installed.files.length,
    bytes: installed.bytes,
  };
}

export async function listCommand(values: Values): Promise<Record<string, unknown>> {
  const home = path.resolve(text(values, "home") ?? defaultAppsHome());
  return { ok: true, command: "list", home, apps: await listInstalled(home) };
}

export async function uninstallCommand(
  reference: string | undefined,
  values: Values,
): Promise<Record<string, unknown>> {
  const home = path.resolve(text(values, "home") ?? defaultAppsHome());
  const result = await uninstallApp(home, required(reference, "应用 id 或 id@version"));
  return { ok: result.removed, command: "uninstall", home, ...result };
}

export async function sandboxCommand(
  dir: string | undefined,
  tool: string | undefined,
  values: Values,
): Promise<Record<string, unknown>> {
  const policy = text(values, "policy");
  const result = await runSandboxed({
    castDir: path.resolve(required(dir, "cast 目录")),
    verb: "invoke",
    name: required(tool, "工具名"),
    args: jsonArgs(values),
    policy: policy === "strict" || policy === "relaxed" ? policy : "local",
    workspace: path.resolve(text(values, "workspace") ?? process.cwd()),
    ...(text(values, "timeout") ? { timeoutMs: Number(text(values, "timeout")) } : {}),
    ...(text(values, "memory") ? { memoryMb: Number(text(values, "memory")) } : {}),
  });
  return { ...result, command: "sandbox", schemaVersion: 1 };
}

export async function auditCommand(values: Values): Promise<Record<string, unknown>> {
  const workspace = path.resolve(text(values, "workspace") ?? process.cwd());
  const limit = Math.min(200, Math.max(1, Number(text(values, "limit") ?? 50)));
  return { ok: true, command: "audit", workspace, events: await readAudit(workspace, limit) };
}

export async function evalCommand(): Promise<Record<string, unknown>> {
  const os = await import("node:os");
  const base = path.join(os.tmpdir(), `kiln-fusion-${process.pid}`);
  const report = await runFusionEval(base);
  return { ok: report.ok, command: "eval", schemaVersion: 1, report };
}

export async function mcpHttpCommand(dir: string | undefined, values: Values): Promise<void> {
  const castsDir = path.resolve(required(dir, "应用目录"));
  const server = await startMcpHttp({
    castsDir,
    port: text(values, "port") ? Number(text(values, "port")) : 0,
    ...(text(values, "token") ? { token: text(values, "token") } : {}),
    tenant: text(values, "tenant") ?? "default",
  });
  process.stderr.write(`Kiln HTTP MCP 已启动：${server.url}/mcp（SSE：${server.url}/sse）\n`);
}
