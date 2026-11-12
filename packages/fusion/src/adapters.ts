import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KilnError, validateManifest, type Issue } from "#grain";
import { loadCast } from "#pact";
import { CastRunner, STRICT_POLICY } from "#host";
import { importArtifact, readArtifact, verifyArtifact } from "./artifact.ts";
import { scaffoldCastProject } from "./scaffold.ts";
import { appendAudit, invokeIsolated } from "./security.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_ROOT = path.resolve(HERE, "..", "..", "..");

/* ——— 内置 cast 脚手架（实现见 scaffold.ts，这里只保留兼容入口） ——— */

export interface CastInitResult {
  readonly castDir: string;
  readonly files: readonly string[];
}

/**
 * 兼容入口：`kiln cast init` 用 minimal 模板生成一份可直接 check 通过的 cast。
 * 需要模板选择、README、.gitignore 时用 `kiln new`。
 */
export async function initCast(
  projectDir: string,
  options: { id?: string; title?: string } = {},
): Promise<CastInitResult> {
  const root = path.resolve(projectDir);
  const result = await scaffoldCastProject({
    dir: path.join(root, "kiln"),
    projectRoot: root,
    template: "minimal",
    docs: false,
    force: true,
    // 保持历史默认值：既有脚本与评测都按 id "cast" 引用。
    id: options.id ?? "cast",
    ...(options.title === undefined ? {} : { title: options.title }),
  });
  return { castDir: result.castDir, files: result.files };
}

/**
 * 同时接受两种布局：cast.json 直接在本目录（`kiln new` 的产物），
 * 或在本目录的 `kiln/` 子目录（`kiln cast init` 的产物）。
 * 少一种兼容，用户就会在「明明检查过了」的地方卡住。
 */
async function resolveCastDir(projectDir: string): Promise<string> {
  const root = path.resolve(projectDir);
  try {
    await readFile(path.join(root, "cast.json"), "utf8");
    return root;
  } catch {
    return path.join(root, "kiln");
  }
}

export async function checkCast(
  projectDir: string,
): Promise<{ ok: boolean; issues: readonly Issue[]; castDir: string }> {
  const castDir = await resolveCastDir(projectDir);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(castDir, "cast.json"), "utf8"));
  } catch (error) {
    throw new KilnError({
      code: "KILN_FUSION_CAST",
      message: `找不到 Kiln cast 目录：${castDir}`,
      hint: "先运行 kiln new <目录> 或 kiln cast init <项目目录>；check 会找 <目录>/cast.json 或 <目录>/kiln/cast.json。",
      detail: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
  const result = validateManifest(raw, { file: path.join(castDir, "cast.json") });
  const loaded = await loadCast({ dir: castDir });
  const issues = [...result.issues, ...(loaded.ok ? [] : loaded.issues)];
  return { ok: issues.length === 0, issues, castDir };
}

/* ——— 宿主生命周期（Kiln 内置） ——— */

export type HostStatus = "installed" | "approved" | "disabled";

export interface HostApp {
  readonly id: string;
  readonly version: string;
  readonly status: HostStatus;
  readonly dir: string;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly grants: Record<string, unknown>;
  readonly approvedBy?: string;
  readonly deniedReason?: string;
}

interface HostState {
  readonly schemaVersion: 1;
  readonly apps: HostApp[];
}

export function hostRoot(workspace: string, tenant = "default"): string {
  return path.join(path.resolve(workspace), ".kiln", "hosts", tenant);
}

function stateFile(root: string): string {
  return path.join(root, "apps.json");
}

async function readState(root: string): Promise<HostState> {
  try {
    return JSON.parse(await readFile(stateFile(root), "utf8")) as HostState;
  } catch {
    return { schemaVersion: 1, apps: [] };
  }
}

async function saveState(root: string, state: HostState): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(stateFile(root), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function findApp(state: HostState, id: string): HostApp {
  const app = state.apps.find((item) => item.id === id);
  if (!app) {
    throw new KilnError({
      code: "KILN_FUSION_HOST",
      message: `宿主中未安装应用：${id}`,
      hint: "用 kiln host list 查看已安装应用，或先执行 host install。",
    });
  }
  return app;
}

export interface InstallOptions {
  readonly tenant?: string;
  readonly publicKeys?: Record<string, string>;
  readonly requireSignature?: boolean;
}

/** 安装：校验 artifact → 解包 → 登记为 installed（默认不授予运行权限）。 */
export async function hostInstall(
  artifactFile: string,
  workspace: string,
  options: InstallOptions = {},
): Promise<HostApp> {
  const root = hostRoot(workspace, options.tenant);
  const artifact = await readArtifact(artifactFile);
  const verified = await verifyArtifact(artifact, {
    ...(options.publicKeys ? { publicKeys: options.publicKeys } : {}),
    requireSignature: options.requireSignature === true,
  });
  if (!verified.ok || !verified.artifact) {
    throw new KilnError({
      code: "KILN_FUSION_ARTIFACT",
      message: "artifact 校验失败，拒绝安装",
      detail: { issues: verified.issues },
    });
  }
  const dir = path.join(root, "apps", verified.artifact.id);
  await rm(dir, { recursive: true, force: true });
  await importArtifact(artifactFile, dir);
  const state = await readState(root);
  const now = new Date().toISOString();
  const app: HostApp = {
    id: verified.artifact.id,
    version: verified.artifact.version,
    status: "installed",
    dir,
    installedAt: now,
    updatedAt: now,
    grants: (verified.artifact.manifest.grants as Record<string, unknown>) ?? {},
  };
  await saveState(root, { schemaVersion: 1, apps: [...state.apps.filter((item) => item.id !== app.id), app] });
  await appendAudit(workspace, {
    at: now,
    tenant: options.tenant ?? "default",
    castId: app.id,
    verb: "install",
    name: app.version,
    ok: true,
  });
  return app;
}

export async function hostList(workspace: string, tenant = "default"): Promise<HostApp[]> {
  return (await readState(hostRoot(workspace, tenant))).apps;
}

async function setStatus(
  workspace: string,
  id: string,
  status: HostStatus,
  options: { tenant?: string; by?: string; reason?: string } = {},
): Promise<HostApp> {
  const tenant = options.tenant ?? "default";
  const root = hostRoot(workspace, tenant);
  const state = await readState(root);
  const current = findApp(state, id);
  const updated: HostApp = {
    ...current,
    status,
    updatedAt: new Date().toISOString(),
    ...(status === "approved" ? { approvedBy: options.by ?? "用户" } : {}),
    ...(status === "installed" && options.reason ? { deniedReason: options.reason } : {}),
  };
  await saveState(root, { schemaVersion: 1, apps: state.apps.map((item) => (item.id === id ? updated : item)) });
  await appendAudit(workspace, {
    at: updated.updatedAt,
    tenant,
    castId: id,
    verb: status,
    name: options.by ?? "用户",
    ok: status === "approved",
    ...(options.reason ? { note: options.reason } : {}),
  });
  return updated;
}

export function hostApprove(
  workspace: string,
  id: string,
  options: { tenant?: string; by?: string } = {},
): Promise<HostApp> {
  return setStatus(workspace, id, "approved", options);
}

export function hostDeny(
  workspace: string,
  id: string,
  options: { tenant?: string; reason?: string } = {},
): Promise<HostApp> {
  return setStatus(workspace, id, "installed", { ...options, reason: options.reason ?? "用户撤销授权" });
}

export function hostEnable(workspace: string, id: string, tenant = "default"): Promise<HostApp> {
  return setStatus(workspace, id, "approved", { tenant });
}

export function hostDisable(workspace: string, id: string, tenant = "default"): Promise<HostApp> {
  return setStatus(workspace, id, "disabled", { tenant });
}

export interface HostRunOptions {
  readonly tenant?: string;
  readonly verb?: "invoke" | "observe" | "act";
  readonly name?: string;
  readonly args?: Record<string, unknown>;
  readonly isolated?: boolean;
}

/** 运行：只有 approved 应用可调用；每次调用写审计，支持子进程隔离。 */
export async function hostRun(workspace: string, id: string, options: HostRunOptions = {}): Promise<unknown> {
  const tenant = options.tenant ?? "default";
  const root = hostRoot(workspace, tenant);
  const app = findApp(await readState(root), id);
  const verb = options.verb ?? "invoke";
  const name = options.name ?? "";
  const at = new Date().toISOString();
  if (app.status !== "approved") {
    await appendAudit(workspace, {
      at,
      tenant,
      castId: id,
      verb,
      name,
      ok: false,
      code: "KILN_FUSION_APPROVAL",
      note: `应用状态为 ${app.status}，需先审批`,
    });
    throw new KilnError({
      code: "KILN_FUSION_APPROVAL",
      message: `应用 ${id} 尚未获批，拒绝运行`,
      hint: "运行 kiln host approve <id> 完成审批后再调用。",
      detail: { status: app.status },
    });
  }
  try {
    let value: unknown;
    if (verb === "invoke" && options.isolated) {
      value = (
        await invokeIsolated({
          castDir: app.dir,
          tool: name,
          args: options.args,
          runtimeRoot: RUNTIME_ROOT,
          policy: "strict",
          workspace: root,
          tenant,
        })
      ).value;
    } else {
      const loaded = await loadCast({ dir: app.dir });
      if (!loaded.ok)
        throw new KilnError({ code: "KILN_FUSION_HOST", message: "应用加载失败", detail: { issues: loaded.issues } });
      const runner = new CastRunner({
        cast: loaded.cast,
        policy: STRICT_POLICY,
        paths: { dataDir: path.join(root, "data", id), workspace: root },
      });
      if (verb === "observe") value = (await runner.observe()).observation;
      else if (verb === "act") value = (await runner.act({ ...(options.args ?? {}), type: name })).outcome;
      else value = (await runner.invoke(name, options.args ?? {})).value;
    }
    await appendAudit(workspace, { at, tenant, castId: id, verb, name, ok: true });
    return value;
  } catch (error) {
    await appendAudit(workspace, {
      at,
      tenant,
      castId: id,
      verb,
      name,
      ok: false,
      code: (error as { code?: string }).code ?? "KILN_CALL_FAILED",
    });
    throw error;
  }
}

export async function hostPanel(workspace: string, id: string, tenant = "default"): Promise<Record<string, unknown>> {
  const root = hostRoot(workspace, tenant);
  const app = findApp(await readState(root), id);
  const loaded = await loadCast({ dir: app.dir });
  if (!loaded.ok) throw new KilnError({ code: "KILN_FUSION_HOST", message: "应用加载失败" });
  const runner = new CastRunner({
    cast: loaded.cast,
    policy: STRICT_POLICY,
    paths: { dataDir: path.join(root, "data", id), workspace: root },
  });
  const state = loaded.cast.manifest.verbs.includes("observe") ? (await runner.observe()).observation.fields : {};
  return { id, version: app.version, status: app.status, state, actions: loaded.cast.manifest.actions };
}

export async function hostUpdate(
  artifactFile: string,
  workspace: string,
  options: InstallOptions = {},
): Promise<HostApp> {
  const root = hostRoot(workspace, options.tenant);
  const artifact = await readArtifact(artifactFile);
  const previous = (await readState(root)).apps.find((item) => item.id === artifact.id);
  const installed = await hostInstall(artifactFile, workspace, options);
  if (previous?.status === "approved") await hostApprove(workspace, artifact.id, { tenant: options.tenant });
  return installed;
}

export async function hostUninstall(workspace: string, id: string, tenant = "default"): Promise<{ removed: boolean }> {
  const root = hostRoot(workspace, tenant);
  const state = await readState(root);
  const app = state.apps.find((item) => item.id === id);
  if (!app) return { removed: false };
  await rm(app.dir, { recursive: true, force: true });
  await saveState(root, { schemaVersion: 1, apps: state.apps.filter((item) => item.id !== id) });
  await appendAudit(workspace, {
    at: new Date().toISOString(),
    tenant,
    castId: id,
    verb: "uninstall",
    name: app.version,
    ok: true,
  });
  return { removed: true };
}

export async function hostDirs(workspace: string, tenant = "default"): Promise<string[]> {
  const root = path.join(hostRoot(workspace, tenant), "apps");
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}
