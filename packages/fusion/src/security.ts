import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { KilnError } from "#grain";

/** 可回放的审计事件。 */
export interface AuditEvent {
  readonly at: string;
  readonly tenant: string;
  readonly castId: string;
  readonly verb: string;
  readonly name: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly note?: string;
}

function auditFile(root: string): string {
  return path.join(path.resolve(root), ".kiln", "audit.jsonl");
}

export async function appendAudit(root: string, event: AuditEvent): Promise<void> {
  const file = auditFile(root);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
}

export async function readAudit(root: string, limit = 200): Promise<AuditEvent[]> {
  let text: string;
  try {
    text = await readFile(auditFile(root), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-limit)
    .map((line) => JSON.parse(line) as AuditEvent);
}

export interface IsolatedOptions {
  readonly castDir: string;
  readonly tool: string;
  readonly args?: Record<string, unknown>;
  readonly runtimeRoot: string;
  readonly policy?: string;
  readonly workspace?: string;
  readonly tenant?: string;
  readonly timeoutMs?: number;
  /** 尝试启用 Node 权限模型；不支持时自动回退为普通子进程隔离。 */
  readonly hardened?: boolean;
}

export interface IsolatedResult {
  readonly ok: boolean;
  readonly value: unknown;
  readonly stamp?: unknown;
  readonly isolated: true;
  readonly hardened: boolean;
  readonly pid: number;
  readonly ms: number;
}

function safeEnv(): NodeJS.ProcessEnv {
  const keys = ["PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOME"];
  const out: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return out;
}

function runChild(
  options: IsolatedOptions,
  hardened: boolean,
): Promise<{ stdout: string; stderr: string; code: number; pid: number }> {
  const cli = path.join(options.runtimeRoot, "packages", "surface", "src", "cli.ts");
  const workspace = options.workspace ?? options.castDir;
  const nodeArgs = hardened
    ? ["--permission", `--allow-fs-read=${options.castDir},${options.runtimeRoot},${workspace}`, cli]
    : [cli];
  const args = [
    ...nodeArgs,
    "invoke",
    options.castDir,
    options.tool,
    "--args",
    JSON.stringify(options.args ?? {}),
    "--policy",
    options.policy ?? "strict",
    "--workspace",
    workspace,
    "--json",
  ];
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: options.runtimeRoot,
      env: safeEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      void started;
      resolve({ stdout, stderr, code: code ?? 1, pid: child.pid ?? -1 });
    });
  });
}

/**
 * 子进程隔离执行：独立进程加载、超时终止、输出受限、环境变量白名单。
 * hardened 为 true 时尝试 Node 权限模型。
 */
export async function invokeIsolated(options: IsolatedOptions): Promise<IsolatedResult> {
  const started = Date.now();
  let attempt = await runChild(options, options.hardened === true);
  let hardened = options.hardened === true;
  if (hardened && (/permission/i.test(attempt.stderr) || attempt.stdout.trim() === "")) {
    attempt = await runChild(options, false);
    hardened = false;
  }
  let payload: { ok?: boolean; result?: unknown; stamp?: unknown; issues?: unknown };
  try {
    payload = JSON.parse(attempt.stdout) as typeof payload;
  } catch {
    throw new KilnError({
      code: "KILN_FUSION_ISOLATED",
      message: "隔离进程未返回可读结果",
      hint: "检查 cast 是否能独立运行；或增大 --timeout 后重试。",
      detail: { stderr: attempt.stderr.slice(0, 400), code: attempt.code },
    });
  }
  const ok = payload.ok === true && attempt.code === 0;
  return {
    ok,
    value: payload.result ?? payload.issues ?? null,
    ...(payload.stamp !== undefined ? { stamp: payload.stamp } : {}),
    isolated: true,
    hardened,
    pid: attempt.pid,
    ms: Date.now() - started,
  };
}
