import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { KilnError } from "#grain";
import { statePath } from "./bundle.ts";
import type { OneState, PermissionState, UpConfig } from "./types.ts";

export function defaultState(bundleDir: string): OneState {
  return {
    schemaVersion: 1,
    bundle: bundleDir,
    permissions: { status: "pending" },
    connections: [],
    lastCheck: null,
    autostart: null,
  };
}

/** 状态文件损坏不静默回退。 */
export async function loadState(bundleDir: string): Promise<OneState> {
  const file = statePath(bundleDir);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return defaultState(bundleDir);
    throw new KilnError({
      code: "KILN_ONE_STATE",
      message: `连接状态不可读: ${file}`,
      hint: "备份后删除 .kiln/state/one-state.json，再运行 `kiln up <bundle>` 重建。",
      detail: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new KilnError({
      code: "KILN_ONE_STATE",
      message: "连接状态文件必须是 JSON 对象",
      hint: "删除 .kiln/state/one-state.json 后重新运行 `kiln up <bundle>`。",
      detail: { file },
    });
  }
  const state = raw as Partial<OneState>;
  if (state.schemaVersion !== 1 || !Array.isArray(state.connections) || state.permissions === undefined) {
    throw new KilnError({
      code: "KILN_ONE_STATE",
      message: "连接状态文件结构不合规或版本不兼容",
      hint: "删除 .kiln/state/one-state.json 后重新运行 `kiln up <bundle>`。",
      detail: { file, schemaVersion: state.schemaVersion },
    });
  }
  return state as OneState;
}

/** 临时文件 + rename，避免进程中断留下半写状态。 */
export async function saveState(bundleDir: string, state: OneState): Promise<void> {
  const file = statePath(bundleDir);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

/** 人话权限清单：首屏只显示这几行，不暴露 grants / 策略档位。 */
export function humanPermissions(config: UpConfig): string[] {
  return config.permissions.map((item) => `${item.human}（${item.scope}）`);
}

export async function grantPermissions(bundleDir: string, config: UpConfig, source: string): Promise<PermissionState> {
  const state = await loadState(bundleDir);
  const permissions: PermissionState = {
    status: "granted",
    grantedAt: new Date().toISOString(),
    source,
    policy: config.policy,
  };
  await saveState(bundleDir, { ...state, permissions });
  return permissions;
}

export async function revokePermissions(bundleDir: string): Promise<PermissionState> {
  const state = await loadState(bundleDir);
  const permissions: PermissionState = {
    status: "revoked",
    revokedAt: new Date().toISOString(),
  };
  await saveState(bundleDir, { ...state, permissions });
  return permissions;
}

export async function assertGranted(bundleDir: string): Promise<PermissionState> {
  const state = await loadState(bundleDir);
  if (state.permissions.status !== "granted") {
    throw new KilnError({
      code: "KILN_ONE_APPROVAL",
      message: `一键包授权状态为 ${state.permissions.status}，无法连接`,
      hint: "运行 `kiln permissions grant <bundle>` 完成一次授权，或在状态面板点「重新授权」。",
      detail: { status: state.permissions.status },
    });
  }
  return state.permissions;
}
