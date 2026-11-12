import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateKeypair, loadPublicKeys, buildArtifact, writeArtifact, verifyArtifact } from "./artifact.ts";
import {
  initCast,
  checkCast,
  hostInstall,
  hostApprove,
  hostDeny,
  hostRun,
  hostPanel,
  hostUninstall,
  hostList,
  RUNTIME_ROOT,
} from "./adapters.ts";
import { startMcpHttp, buildDiscovery, searchDiscovery, tenantPaths } from "./bridge.ts";
import { invokeIsolated, readAudit } from "./security.ts";

export interface FusionTask {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail?: string;
}

export interface FusionReport {
  readonly ok: boolean;
  readonly at: string;
  readonly tasks: readonly FusionTask[];
  readonly passed: number;
  readonly failed: number;
  readonly rounds: number;
  readonly ms: number;
  readonly artifactBytes: number;
  readonly auditEvents: number;
  readonly denied: number;
  readonly isolatedPid: number | null;
  readonly tenantIsolated: boolean;
  readonly hardened: boolean;
}

/** 跨宿主端到端评测：Kiln 原生 cast 生成 → 签名 artifact → 宿主安装审批 → 双通道调用 → 撤销 → 卸载。 */
export async function runFusionEval(base: string): Promise<FusionReport> {
  const started = Date.now();
  const workspace = path.join(base, "fusion-eval");
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const tasks: FusionTask[] = [];
  let artifactBytes = 0;
  let denied = 0;
  let isolatedPid: number | null = null;
  let hardened = false;
  let tenantIsolated = false;

  const step = async (name: string, task: () => Promise<string | void>) => {
    const at = Date.now();
    try {
      const detail = await task();
      tasks.push({ name, ok: true, ms: Date.now() - at, ...(detail ? { detail } : {}) });
    } catch (error) {
      tasks.push({
        name,
        ok: false,
        ms: Date.now() - at,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const project = path.join(workspace, "native-cast");
  await mkdir(project, { recursive: true });
  const keys = await generateKeypair(path.join(workspace, "keys"));
  let castDir = "";
  let artifactFile = "";

  await step("原生 cast 生成与校验", async () => {
    const init = await initCast(project);
    castDir = init.castDir;
    const checked = await checkCast(project);
    if (!checked.ok) throw new Error(`校验未通过：${checked.issues.map((item) => item.code).join(",")}`);
    return `已生成 ${init.files.length} 个文件`;
  });

  await step("版本化 artifact 构建与 Ed25519 签名", async () => {
    const built = await buildArtifact(castDir, { sign: { privateKey: keys.privateKey, keyId: keys.keyId } });
    artifactFile = path.join(workspace, `${built.artifact.id}@${built.artifact.version}.kiln.json`);
    await writeArtifact(artifactFile, built.artifact);
    artifactBytes = built.bytes;
    return `${artifactBytes} 字节，摘要 ${built.digest.slice(0, 12)}`;
  });

  await step("签名与完整性校验", async () => {
    const result = await verifyArtifact(artifactFile, {
      publicKeys: await loadPublicKeys(path.join(workspace, "keys")),
      requireSignature: true,
    });
    if (!result.ok) throw new Error(result.issues.map((item) => item.message).join("；"));
    return "签名有效";
  });

  await step("宿主安装（默认未授权）", async () => {
    const app = await hostInstall(artifactFile, workspace, {
      publicKeys: await loadPublicKeys(path.join(workspace, "keys")),
      requireSignature: true,
    });
    if (app.status !== "installed") throw new Error("安装后状态不正确");
    return `${app.id}@${app.version}`;
  });

  await step("人类审批后运行 invoke", async () => {
    await hostApprove(workspace, "cast", { by: "评测" });
    const value = (await hostRun(workspace, "cast", { verb: "invoke", name: "ping" })) as { ok?: boolean };
    if (value.ok !== true) throw new Error("调用结果不正确");
    return "ping 通过";
  });

  await step("UI 与 agent 共用 observe 契约", async () => {
    const panel = await hostPanel(workspace, "cast");
    if (panel.id !== "cast") throw new Error("面板状态不正确");
    return "面板可用";
  });

  await step("HTTP MCP 工具表与调用", async () => {
    const server = await startMcpHttp({ castsDir: castDir, port: 0, tenant: "eval" });
    try {
      const response = await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const payload = (await response.json()) as { result?: { tools?: unknown[] } };
      if (!payload.result?.tools?.length) throw new Error("工具表为空");
      return `${payload.result.tools.length} 个工具`;
    } finally {
      await server.close();
    }
  });

  await step("发现层意图检索", async () => {
    const index = await buildDiscovery([castDir]);
    const hits = searchDiscovery(index, "示例");
    if (hits.length === 0) throw new Error("未命中");
    return `命中 ${hits.length} 个应用`;
  });

  await step("多租户数据目录隔离", async () => {
    const a = tenantPaths(workspace, "tenant-a", "cast").dataDir;
    const b = tenantPaths(workspace, "tenant-b", "cast").dataDir;
    tenantIsolated = a !== b;
    if (!tenantIsolated) throw new Error("租户目录未隔离");
    return "目录独立";
  });

  await step("子进程隔离调用", async () => {
    const result = await invokeIsolated({
      castDir,
      tool: "ping",
      runtimeRoot: RUNTIME_ROOT,
      policy: "strict",
      workspace,
    });
    isolatedPid = result.pid;
    hardened = result.hardened;
    if (!result.ok) throw new Error("隔离调用失败");
    if (result.pid === process.pid) throw new Error("未脱离宿主进程");
    return `子进程 ${result.pid}`;
  });

  await step("撤销授权后拒绝运行", async () => {
    await hostDeny(workspace, "cast", { reason: "评测撤销" });
    try {
      await hostRun(workspace, "cast", { verb: "invoke", name: "ping" });
      throw new Error("撤销后仍可运行");
    } catch (error) {
      if ((error as { code?: string }).code !== "KILN_FUSION_APPROVAL") throw error;
      denied += 1;
      return "拒绝生效";
    }
  });

  await step("卸载与状态清理", async () => {
    await hostUninstall(workspace, "cast");
    if ((await hostList(workspace)).length !== 0) throw new Error("卸载后仍有应用");
    return "已卸载";
  });

  const auditEvents = (await readAudit(workspace, 500)).length;
  const passed = tasks.filter((task) => task.ok).length;
  return {
    ok: passed === tasks.length,
    at: new Date().toISOString(),
    tasks,
    passed,
    failed: tasks.length - passed,
    rounds: tasks.length,
    ms: Date.now() - started,
    artifactBytes,
    auditEvents,
    denied,
    isolatedPid,
    tenantIsolated,
    hardened,
  };
}
