import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KilnError } from "#grain";
import { cliPath, isRecord, portableConfigPath } from "./bundle.ts";
import type { ConnectionRecord, UpConfig } from "./types.ts";

export const SERVER_NAME = "kiln-one";

interface ClientTarget {
  readonly id: string;
  readonly configPath: string;
  readonly createIfMissing: boolean;
}

export type McpEntry = {
  readonly command: string;
  readonly args: readonly string[];
};

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.KILN_ONE_HOME ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
}

function knownClientPath(name: string, home: string, env: NodeJS.ProcessEnv, bundleDir: string): string | null {
  if (name === "bundle") return portableConfigPath(bundleDir);
  if (name === "cursor") return path.join(home, ".cursor", "mcp.json");
  if (name === "claude-desktop") {
    if (process.platform === "win32") {
      return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    }
    if (process.platform === "darwin") {
      return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    }
    return path.join(home, ".config", "Claude", "claude_desktop_config.json");
  }
  return null;
}

/**
 * 探测可写入的 MCP 客户端配置。
 * - 包内 .mcp.json 总是生成，作为可导入的便携配置；
 * - 全局客户端只在配置文件已存在时才写入，不给没装的软件制造垃圾；
 * - KILN_ONE_CLIENT_CONFIG / KILN_ONE_HOME 用于测试与自定义部署。
 */
export function clientTargets(
  bundleDir: string,
  config: UpConfig,
  env: NodeJS.ProcessEnv = process.env,
  override?: readonly string[],
): ClientTarget[] {
  const selected =
    override ?? (typeof env.KILN_ONE_CLIENTS === "string" ? env.KILN_ONE_CLIENTS.split(",") : config.clients);
  if (selected === "none") return [];
  const targets: ClientTarget[] = [];
  const home = homeOf(env);

  if (selected === "auto") {
    targets.push({ id: "bundle", configPath: portableConfigPath(bundleDir), createIfMissing: true });
    for (const name of ["claude-desktop", "cursor"]) {
      const file = knownClientPath(name, home, env, bundleDir);
      if (file) targets.push({ id: name, configPath: file, createIfMissing: false });
    }
  } else {
    for (const name of selected) {
      const trimmed = name.trim();
      if (trimmed === "") continue;
      const file = knownClientPath(trimmed, home, env, bundleDir);
      if (file) targets.push({ id: trimmed, configPath: file, createIfMissing: trimmed === "bundle" });
    }
  }

  const custom = env.KILN_ONE_CLIENT_CONFIG;
  if (custom) {
    for (const [index, file] of custom.split(path.delimiter).entries()) {
      if (file.trim() === "") continue;
      targets.push({ id: `custom-${index}`, configPath: path.resolve(file.trim()), createIfMissing: true });
    }
  }
  return targets;
}

/** stdio 由 agent 客户端按需拉起：配置持久化即「常驻」，无需后台守护进程。 */
export function mcpServerEntry(bundleDir: string, config: UpConfig, runtimeRoot: string): McpEntry {
  return {
    command: process.execPath,
    args: [
      cliPath(runtimeRoot),
      "mcp",
      path.join(bundleDir, config.appsDir),
      "--policy",
      config.policy,
      "--workspace",
      bundleDir,
    ],
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function readConfig(
  file: string,
  createIfMissing: boolean,
): Promise<{ data: Record<string, unknown>; existed: boolean } | null> {
  if (!(await exists(file))) {
    if (!createIfMissing) return null;
    return { data: {}, existed: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new KilnError({
      code: "KILN_ONE_CLIENT",
      message: `客户端配置不是合法 JSON: ${file}`,
      hint: "先备份并修复该配置文件，再运行 `kiln up`；Kiln 不会覆盖损坏的用户配置。",
      detail: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
  if (!isRecord(parsed)) {
    throw new KilnError({
      code: "KILN_ONE_CLIENT",
      message: `客户端配置根必须是对象: ${file}`,
      hint: "修复该配置文件后重试；Kiln 不会覆盖它。",
      detail: { file },
    });
  }
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw new KilnError({
      code: "KILN_ONE_CLIENT",
      message: `mcpServers 必须是对象: ${file}`,
      hint: "修复该字段后重试；Kiln 不会覆盖它。",
      detail: { file },
    });
  }
  return { data: parsed, existed: true };
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

function sameEntry(left: unknown, right: McpEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface RegisterResult {
  readonly records: readonly ConnectionRecord[];
  readonly skipped: readonly string[];
}

/** 合并写入，幂等；首次修改前留一份 .bak，绝不整体覆盖用户配置。 */
export async function registerAll(options: {
  readonly bundleDir: string;
  readonly config: UpConfig;
  readonly runtimeRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly clients?: readonly string[];
  readonly previous?: readonly ConnectionRecord[];
}): Promise<RegisterResult> {
  const env = options.env ?? process.env;
  const entry = mcpServerEntry(options.bundleDir, options.config, options.runtimeRoot);
  const targets = clientTargets(options.bundleDir, options.config, env, options.clients);
  const records: ConnectionRecord[] = [];
  const skipped: string[] = [];

  for (const target of targets) {
    const loaded = await readConfig(target.configPath, target.createIfMissing);
    if (!loaded) {
      skipped.push(`${target.id}: 配置文件不存在（未安装或尚未创建）`);
      continue;
    }
    const servers = isRecord(loaded.data.mcpServers) ? { ...loaded.data.mcpServers } : {};
    if (sameEntry(servers[SERVER_NAME], entry)) {
      const old = (options.previous ?? []).find((item) => item.configPath === target.configPath);
      records.push(
        old ?? {
          client: target.id,
          configPath: target.configPath,
          serverName: SERVER_NAME,
          addedAt: new Date().toISOString(),
        },
      );
      continue;
    }
    let backupPath: string | undefined;
    if (loaded.existed) {
      const backup = `${target.configPath}.kiln-one.bak`;
      if (!(await exists(backup))) {
        await copyFile(target.configPath, backup);
      }
      backupPath = backup;
    }
    servers[SERVER_NAME] = entry;
    await writeJsonAtomic(target.configPath, { ...loaded.data, mcpServers: servers });
    records.push({
      client: target.id,
      configPath: target.configPath,
      serverName: SERVER_NAME,
      addedAt: new Date().toISOString(),
      ...(backupPath ? { backupPath } : {}),
    });
  }
  return { records, skipped };
}

/** 即使不注册任何客户端，也保留一份可导入的便携配置。 */
export async function writePortableConfig(options: {
  readonly bundleDir: string;
  readonly config: UpConfig;
  readonly runtimeRoot: string;
}): Promise<string> {
  const file = portableConfigPath(options.bundleDir);
  const loaded = await readConfig(file, true);
  const servers = loaded && isRecord(loaded.data.mcpServers) ? { ...loaded.data.mcpServers } : {};
  const entry = mcpServerEntry(options.bundleDir, options.config, options.runtimeRoot);
  servers[SERVER_NAME] = entry;
  await writeJsonAtomic(file, { ...(loaded?.data ?? {}), mcpServers: servers });
  return file;
}

export interface UnregisterResult {
  readonly removed: number;
  readonly failed: readonly { readonly path: string; readonly cause: string }[];
}

/** 只删自己加的那一个键，不整体恢复备份（避免抹掉用户后续新增的配置）。 */
export async function unregisterAll(records: readonly ConnectionRecord[]): Promise<UnregisterResult> {
  let removed = 0;
  const failed: { path: string; cause: string }[] = [];
  for (const record of records) {
    if (record.removedAt) continue;
    try {
      const loaded = await readConfig(record.configPath, false);
      if (!loaded || !isRecord(loaded.data.mcpServers)) continue;
      const servers = { ...loaded.data.mcpServers };
      if (!(SERVER_NAME in servers)) continue;
      delete servers[SERVER_NAME];
      await writeJsonAtomic(record.configPath, { ...loaded.data, mcpServers: servers });
      removed += 1;
    } catch (error) {
      failed.push({ path: record.configPath, cause: error instanceof Error ? error.message : String(error) });
    }
  }
  return { removed, failed };
}

export async function connectionAlive(record: ConnectionRecord): Promise<boolean> {
  try {
    const loaded = await readConfig(record.configPath, false);
    if (!loaded || !isRecord(loaded.data.mcpServers)) return false;
    return SERVER_NAME in loaded.data.mcpServers;
  } catch {
    return false;
  }
}
