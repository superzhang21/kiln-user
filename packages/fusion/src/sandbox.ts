import { Worker } from "node:worker_threads";
import { toIssue, type Issue } from "#grain";
import { KilnError } from "#grain";

export interface SandboxOptions {
  readonly castDir: string;
  readonly verb?: "invoke" | "observe" | "act" | "describe";
  readonly name?: string;
  readonly args?: Record<string, unknown>;
  readonly policy?: "local" | "relaxed" | "strict";
  readonly workspace: string;
  readonly dataDir?: string;
  readonly timeoutMs?: number;
  readonly memoryMb?: number;
}

export interface SandboxResult {
  readonly ok: boolean;
  readonly value: unknown;
  readonly ms: number;
  readonly memoryMb: number;
  readonly threadId: number;
  readonly code?: string;
  readonly issues?: readonly Issue[];
}

const DEFAULT_TIMEOUT = 5_000;
const DEFAULT_MEMORY = 128;
const MIN_MEMORY = 32;

/**
 * 受限执行容器：cast 在独立 Worker 线程加载，内存受 V8 堆上限约束，
 * 超时由主线程 terminate 掐断。主线程只拿结果，不执行 cast 代码。
 *
 * 边界：Worker 隔离进程内内存与事件循环，但不是 OS 沙箱；需要更强隔离时走
 * `invokeIsolated({hardened:true})` 的子进程 + Node 权限模型。
 */
export async function runSandboxed(options: SandboxOptions): Promise<SandboxResult> {
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT);
  const memoryMb = Math.max(MIN_MEMORY, options.memoryMb ?? DEFAULT_MEMORY);
  const started = Date.now();

  const worker = new Worker(new URL("./sandbox-worker.ts", import.meta.url), {
    workerData: {
      castDir: options.castDir,
      verb: options.verb ?? "invoke",
      name: options.name ?? "",
      args: options.args ?? {},
      policy: options.policy ?? "local",
      workspace: options.workspace,
      dataDir: options.dataDir ?? `${options.workspace}/.kiln/data/sandbox`,
      timeoutMs,
    },
    resourceLimits: {
      maxOldGenerationSizeMb: memoryMb,
      maxYoungGenerationSizeMb: Math.min(16, Math.max(4, Math.floor(memoryMb / 8))),
      stackSizeMb: 4,
    },
    stdout: false,
    stderr: false,
  });

  const finish = async (result: SandboxResult): Promise<SandboxResult> => {
    await worker.terminate().catch(() => undefined);
    return result;
  };

  return await new Promise<SandboxResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void finish({
        ok: false,
        value: null,
        ms: Date.now() - started,
        memoryMb,
        threadId: worker.threadId,
        code: "KILN_SANDBOX_TIMEOUT",
        issues: [
          toIssue(
            new KilnError({
              code: "KILN_SANDBOX_TIMEOUT",
              message: `cast 执行超过 ${timeoutMs} ms，已终止`,
              hint: "把长任务拆成多次 invoke，或增大 --timeout；死循环会被强制掐断。",
            }),
          ),
        ],
      }).then(resolve);
    }, timeoutMs);

    worker.once("message", (payload: { ok: boolean; value?: unknown; ms?: number; issues?: readonly Issue[] }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void finish({
        ok: payload.ok,
        value: payload.value ?? null,
        ms: payload.ms ?? Date.now() - started,
        memoryMb,
        threadId: worker.threadId,
        ...(payload.issues ? { issues: payload.issues, code: payload.issues[0]?.code } : {}),
      }).then(resolve);
    });

    worker.once("error", (error: Error & { code?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const oom = /out of memory|ERR_WORKER_OUT_OF_MEMORY|heap limit/i.test(`${error.code ?? ""} ${error.message}`);
      const code = oom ? "KILN_SANDBOX_MEMORY" : "KILN_SANDBOX_CRASH";
      void finish({
        ok: false,
        value: null,
        ms: Date.now() - started,
        memoryMb,
        threadId: worker.threadId,
        code,
        issues: [
          toIssue(
            new KilnError({
              code,
              message: oom ? `cast 超出 ${memoryMb} MB 内存上限，已终止` : "cast 在隔离线程中崩溃",
              hint: oom ? "精简单次处理的数据量，或增大 --memory。" : "检查 pact.ts 是否在模块加载阶段就抛错。",
              detail: { cause: error.message },
            }),
          ),
        ],
      }).then(resolve);
    });

    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void finish({
        ok: false,
        value: null,
        ms: Date.now() - started,
        memoryMb,
        threadId: worker.threadId,
        code: "KILN_SANDBOX_CRASH",
        issues: [toIssue(new KilnError({ code: "KILN_SANDBOX_CRASH", message: `隔离线程提前退出（code ${code}）` }))],
      }).then(resolve);
    });
  });
}
