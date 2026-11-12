import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { KilnError } from "#grain";
import { readArtifact, verifyArtifact, type Artifact } from "./artifact.ts";

const MAGIC = Buffer.from("KILN1\0", "binary");
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;

export interface InstalledApp {
  readonly id: string;
  readonly version: string;
  readonly dir: string;
  readonly installedAt: string;
  readonly digest: string;
  readonly signed: boolean;
}

interface InstalledState {
  readonly schemaVersion: 1;
  readonly apps: InstalledApp[];
}

export function defaultAppsHome(): string {
  return path.resolve(process.env.KILN_APPS_HOME ?? path.join(os.homedir(), ".kiln"));
}

/** `.kiln` = magic + gzip(JSON)，保持单文件、可校验、可直接分发。 */
export function encodePackage(artifact: Artifact): Buffer {
  return Buffer.concat([MAGIC, gzipSync(Buffer.from(JSON.stringify(artifact), "utf8"), { level: 9 })]);
}

export function decodePackage(buffer: Buffer): Artifact {
  try {
    const body = buffer.subarray(0, MAGIC.length).equals(MAGIC) ? gunzipSync(buffer.subarray(MAGIC.length)) : buffer;
    return JSON.parse(body.toString("utf8")) as Artifact;
  } catch (error) {
    throw new KilnError({
      code: "KILN_PACK_INVALID",
      message: "不是合法的 .kiln 包",
      hint: "用 kiln artifact build --out app.kiln 重新生成；.json 旧格式仍可读。",
      detail: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

export async function writePackage(file: string, artifact: Artifact): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, encodePackage(artifact));
}

export async function readPackage(file: string): Promise<Artifact> {
  return decodePackage(await readFile(file));
}

function digestOf(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function loadSource(source: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(source)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(source, { signal: controller.signal });
      if (!response.ok) {
        throw new KilnError({ code: "KILN_PACK_INSTALL", message: `下载失败：HTTP ${response.status}` });
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > MAX_PACKAGE_BYTES) {
        throw new KilnError({ code: "KILN_PACK_INSTALL", message: `包超过 ${MAX_PACKAGE_BYTES} 字节上限` });
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
  const file = path.resolve(source);
  const body = await readFile(file).catch(() => {
    throw new KilnError({ code: "KILN_PACK_INSTALL", message: `读不到安装包：${file}` });
  });
  if (body.length > MAX_PACKAGE_BYTES) {
    throw new KilnError({ code: "KILN_PACK_INSTALL", message: `包超过 ${MAX_PACKAGE_BYTES} 字节上限` });
  }
  return body;
}

async function extract(artifact: Artifact, dir: string): Promise<string[]> {
  const target = path.resolve(dir);
  const wrote: string[] = [];
  for (const [relative, body] of Object.entries(artifact.files)) {
    const full = path.resolve(target, ...relative.split("/"));
    const inside = path.relative(target, full);
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      throw new KilnError({ code: "KILN_PACK_INVALID", message: `包内路径越界：${relative}` });
    }
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, "utf8");
    wrote.push(full);
  }
  return wrote;
}

function stateFile(home: string): string {
  return path.join(home, "apps.json");
}

async function readState(home: string): Promise<InstalledState> {
  try {
    return JSON.parse(await readFile(stateFile(home), "utf8")) as InstalledState;
  } catch {
    return { schemaVersion: 1, apps: [] };
  }
}

async function writeState(home: string, state: InstalledState): Promise<void> {
  const file = stateFile(home);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

export interface PackageInstallOptions {
  readonly home?: string;
  readonly publicKeys?: Record<string, string>;
  readonly requireSignature?: boolean;
}

export async function installPackage(
  source: string,
  options: PackageInstallOptions = {},
): Promise<{ app: InstalledApp; files: string[]; bytes: number }> {
  const buffer = await loadSource(source);
  const artifact = decodePackage(buffer);
  const verified = await verifyArtifact(artifact, {
    ...(options.publicKeys ? { publicKeys: options.publicKeys } : {}),
    requireSignature: options.requireSignature === true,
  });
  if (!verified.ok) {
    throw new KilnError({
      code: "KILN_PACK_INVALID",
      message: "安装包校验失败，拒绝安装",
      hint: "确认来源可信后用 kiln artifact verify 复查；不要安装被篡改的包。",
      detail: { issues: verified.issues },
    });
  }
  const home = path.resolve(options.home ?? defaultAppsHome());
  const dir = path.join(home, "apps", `${artifact.id}@${artifact.version}`);
  await rm(dir, { recursive: true, force: true });
  const files = await extract(artifact, dir);
  const state = await readState(home);
  const app: InstalledApp = {
    id: artifact.id,
    version: artifact.version,
    dir,
    installedAt: new Date().toISOString(),
    digest: digestOf(buffer),
    signed: Boolean(artifact.signature),
  };
  await writeState(home, {
    schemaVersion: 1,
    apps: [...state.apps.filter((item) => item.id !== app.id), app],
  });
  return { app, files, bytes: buffer.length };
}

export async function listInstalled(home = defaultAppsHome()): Promise<InstalledApp[]> {
  return (await readState(home)).apps;
}

export async function uninstallApp(home: string, reference: string): Promise<{ removed: boolean; app?: InstalledApp }> {
  const state = await readState(home);
  const app =
    state.apps.find((item) => `${item.id}@${item.version}` === reference) ??
    state.apps.find((item) => item.id === reference);
  if (!app) return { removed: false };
  await rm(app.dir, { recursive: true, force: true });
  await writeState(home, { schemaVersion: 1, apps: state.apps.filter((item) => item.id !== app.id) });
  return { removed: true, app };
}

/** 兼容旧 `.kiln.json`。 */
export async function readAnyArtifact(file: string): Promise<Artifact> {
  const buffer = await readFile(file);
  return buffer.subarray(0, MAGIC.length).equals(MAGIC) ? decodePackage(buffer) : readArtifact(file);
}
