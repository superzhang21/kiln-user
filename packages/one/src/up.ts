import path from "node:path";
import { KilnError, type Issue } from "#grain";
import { loadCast } from "#pact";
import {
  appDirs,
  assertRuntime,
  readUpConfig,
  resolveBundleDir,
  resolveRuntimeRoot,
  sealBundle,
  verifyBundle,
} from "./bundle.ts";
import { connectionAlive, registerAll, unregisterAll, writePortableConfig } from "./clients.ts";
import {
  assertGranted,
  grantPermissions,
  humanPermissions,
  loadState,
  revokePermissions,
  saveState,
} from "./permissions.ts";
import { assertHandshake, runHandshake } from "./handshake.ts";
import { disableAutostart, enableAutostart } from "./autostart.ts";
import { OneIssues } from "./errors.ts";
import type {
  ConnectionRecord,
  HandshakeResult,
  PermissionState,
  ReadyReport,
  StatusReport,
  UpConfig,
  UpOptions,
} from "./types.ts";

function cleanRecords(records: readonly ConnectionRecord[]): ConnectionRecord[] {
  return records.map((record) => ({
    client: record.client,
    configPath: record.configPath,
    serverName: record.serverName,
    addedAt: record.addedAt,
    ...(record.backupPath ? { backupPath: record.backupPath } : {}),
  }));
}

function aggregateCastIssues(results: Awaited<ReturnType<typeof loadCast>>[]): { ids: string[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const ids: string[] = [];
  for (const result of results) {
    if (!result.ok) {
      issues.push(...result.issues);
      continue;
    }
    ids.push(result.cast.manifest.id);
  }
  if (new Set(ids).size !== ids.length) {
    issues.push(
      new KilnError({
        code: "KILN_MANIFEST_ID",
        message: "一键包内存在重复 cast id",
        hint: "每个 cast.json 的 id 必须唯一；改 id 后重新运行 `kiln seal <bundle>`。",
        detail: { ids },
      }).issue,
    );
  }
  return { ids, issues };
}

/** 任一步失败都结构化返回；自检失败会回滚已注册的连接。 */
export async function upBundle(options: UpOptions = {}): Promise<ReadyReport> {
  const bundleDir = resolveBundleDir(options.bundle);
  const config = await readUpConfig(bundleDir);
  const runtimeRoot = resolveRuntimeRoot(bundleDir, options.runtimeRoot);
  const node = await assertRuntime(runtimeRoot);

  let integrity = { verified: false, files: 0 };
  if (!options.dev) {
    const checked = await verifyBundle(bundleDir);
    integrity = { verified: checked.ok, files: checked.files };
    if (!checked.ok) throw new OneIssues(checked.issues);
  }

  const dirs = await appDirs(bundleDir, config);
  if (dirs.length === 0) {
    throw new KilnError({
      code: "KILN_ONE_BUNDLE",
      message: `一键包内没有发现任何 cast: ${path.join(bundleDir, config.appsDir)}`,
      hint: "确认 apps/ 目录下每个应用都有 cast.json，然后运行 `kiln seal <bundle>`。",
      detail: { appsDir: config.appsDir },
    });
  }
  const loaded = await Promise.all(dirs.map((dir) => loadCast({ dir })));
  const { ids, issues } = aggregateCastIssues(loaded);
  if (issues.length > 0) throw new OneIssues(issues);

  let state = await loadState(bundleDir);
  if (state.permissions.status !== "granted") {
    // 首次交付（pending）视为一次授权；用户主动撤销（revoked）后必须显式重新授权，不能被再次 up 悄悄恢复。
    if (state.permissions.status === "revoked" || options.requireApproval) await assertGranted(bundleDir);
    else {
      await grantPermissions(bundleDir, config, options.dev ? "bundle-delivery(dev)" : "bundle-delivery");
      state = await loadState(bundleDir);
    }
  }
  await assertGranted(bundleDir);

  let registered: { records: readonly ConnectionRecord[]; skipped: readonly string[] } = { records: [], skipped: [] };
  if (!options.skipRegister) {
    registered = await registerAll({
      bundleDir,
      config,
      runtimeRoot,
      clients: options.clients,
      previous: state.connections,
    });
  }
  const portable = await writePortableConfig({ bundleDir, config, runtimeRoot });

  let handshake: HandshakeResult;
  try {
    if (options.skipHandshake) {
      handshake = { ok: true, at: new Date().toISOString(), ms: 0, tools: 0, describeOk: false, probeOk: false };
    } else {
      handshake = await runHandshake({ bundleDir, config, runtimeRoot });
      assertHandshake(handshake);
    }
  } catch (error) {
    if (registered.records.length > 0) await unregisterAll(registered.records);
    throw error;
  }

  let autostart = state.autostart;
  if (options.autostart || config.autostart) {
    autostart = await enableAutostart({ bundleDir, config, runtimeRoot });
  }

  const connections = cleanRecords(registered.records);
  await saveState(bundleDir, {
    schemaVersion: 1,
    bundle: bundleDir,
    permissions: state.permissions,
    connections,
    lastCheck: handshake,
    autostart,
    ...(state.connectedAt ? { connectedAt: state.connectedAt } : { connectedAt: new Date().toISOString() }),
  });

  const nextSteps = [
    "直接对 agent 说：把这段内容存一下 / 帮我找上个月的发票 / 今天要做什么",
    `查看状态：kiln status ${bundleDir} --json`,
    `撤销授权：kiln permissions revoke ${bundleDir}`,
    `断开连接：kiln down ${bundleDir}`,
  ];
  if (registered.records.length === 0) {
    nextSteps.unshift(`未发现已安装的客户端，把 ${portable} 交给 agent 或导入客户端 MCP 配置即可`);
  }
  return {
    ok: true,
    command: "up",
    schemaVersion: 1,
    human: `已连接：${ids.join("、")}；工具 ${handshake.tools ?? 0} 个；客户端 ${connections.length} 个；权限 ${state.permissions.status}。${humanPermissions(config)[0] ?? ""}`,
    bundle: bundleDir,
    version: config.version,
    policy: config.policy,
    node,
    apps: ids,
    permissions: config.permissions,
    permissionStatus: state.permissions.status,
    connections,
    manualConfig: portable,
    handshake,
    dataDir: path.join(bundleDir, config.dataDir),
    autostart,
    integrity,
    nextSteps,
  };
}

export interface DownReport {
  readonly ok: true;
  readonly command: "down";
  readonly schemaVersion: 1;
  readonly bundle: string;
  readonly removed: number;
  readonly failed: readonly { readonly path: string; readonly cause: string }[];
  readonly autostartRemoved: boolean;
  readonly human: string;
}

/** 断开：移除自己注册的 server、清理自启项，保留授权便于原样重连。 */
export async function downBundle(bundle?: string): Promise<DownReport> {
  const bundleDir = resolveBundleDir(bundle);
  const state = await loadState(bundleDir);
  const result = await unregisterAll(state.connections);
  const autostartRemoved = await disableAutostart(state.autostart);
  const removedAt = new Date().toISOString();
  await saveState(bundleDir, {
    ...state,
    connections: state.connections.map((record) => ({ ...record, removedAt })),
    autostart: null,
  });
  return {
    ok: true,
    command: "down",
    schemaVersion: 1,
    bundle: bundleDir,
    removed: result.removed,
    failed: result.failed,
    autostartRemoved,
    human:
      result.failed.length > 0
        ? `已断开 ${result.removed} 个连接，${result.failed.length} 个配置未能修改（见 failed）。`
        : `已断开 ${result.removed} 个连接${autostartRemoved ? "，并移除开机自启" : ""}。授权仍保留，重连请运行 kiln up。`,
  };
}

export async function statusOf(bundle?: string): Promise<StatusReport> {
  const bundleDir = resolveBundleDir(bundle);
  const config: UpConfig = await readUpConfig(bundleDir);
  const state = await loadState(bundleDir);
  const alive = await Promise.all(state.connections.map((record) => connectionAlive(record)));
  const connected = alive.some(Boolean) && state.permissions.status === "granted";
  const installed = state.connectedAt !== undefined;
  return {
    ok: true,
    command: "status",
    schemaVersion: 1,
    bundle: bundleDir,
    installed,
    connected,
    permissions: state.permissions,
    permissionLines: humanPermissions(config),
    connections: state.connections,
    lastCheck: state.lastCheck,
    autostart: state.autostart,
    manualConfig: path.join(bundleDir, ".mcp.json"),
    human: connected
      ? `已连接，最近自检 ${state.lastCheck?.ok ? "通过" : "未通过/未执行"}，共 ${state.connections.length} 个客户端配置。`
      : installed
        ? "已安装但当前未连接：授权可能被撤销，或客户端配置已被移除。运行 kiln up 重连。"
        : "尚未连接：运行 kiln up <bundle> 或把一键包交给 agent。",
  };
}

export interface SealReport {
  readonly ok: true;
  readonly command: "seal";
  readonly schemaVersion: 1;
  readonly bundle: string;
  readonly files: number;
  readonly checksums: string;
  readonly human: string;
}

export async function sealCommand(bundle?: string): Promise<SealReport> {
  const bundleDir = resolveBundleDir(bundle);
  const sums = await sealBundle(bundleDir);
  return {
    ok: true,
    command: "seal",
    schemaVersion: 1,
    bundle: bundleDir,
    files: Object.keys(sums.files).length,
    checksums: path.join(bundleDir, "checksums.json"),
    human: `已为 ${sums.bundle} 登记 ${Object.keys(sums.files).length} 个文件的 sha256；之后修改应用源码必须重新 seal。`,
  };
}

export interface PermissionReport {
  readonly ok: true;
  readonly command: "permissions";
  readonly schemaVersion: 1;
  readonly bundle: string;
  readonly action: "show" | "grant" | "revoke";
  readonly permissions: PermissionState;
  readonly lines: readonly string[];
  readonly human: string;
}

export async function permissionsCommand(bundle: string | undefined, action: string): Promise<PermissionReport> {
  const bundleDir = resolveBundleDir(bundle);
  const config = await readUpConfig(bundleDir);
  let permissions: PermissionState;
  if (action === "grant") permissions = await grantPermissions(bundleDir, config, "cli:grant");
  else if (action === "revoke") permissions = await revokePermissions(bundleDir);
  else if (action === "show") permissions = (await loadState(bundleDir)).permissions;
  else {
    throw new KilnError({
      code: "KILN_ONE_USAGE",
      message: `未知的权限操作: ${action}`,
      hint: "使用 `kiln permissions <bundle> --action show|grant|revoke`。",
      detail: { action },
    });
  }
  return {
    ok: true,
    command: "permissions",
    schemaVersion: 1,
    bundle: bundleDir,
    action,
    permissions,
    lines: humanPermissions(config),
    human:
      action === "show"
        ? `当前授权：${permissions.status}。${humanPermissions(config).join("；")}`
        : action === "grant"
          ? `已授权。${humanPermissions(config).join("；")}`
          : "已撤销授权。运行 kiln up 前需重新授权。",
  };
}
