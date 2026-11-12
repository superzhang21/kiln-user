import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 后台常驻进程的通用工具：状态文件、存活探测、优雅停止。
 *
 * 只处理「进程」这一件事，不认识 HTTP 也不认识 cast，
 * 所以 `kiln serve --detach/--stop` 之外，任何需要后台化的子命令都能复用。
 */

export interface ServeState {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly target: string;
  readonly startedAt: string;
  readonly logFile: string;
}

/** 后台进程的东西都放这里，卸载时整目录删掉即可，不留垃圾。 */
export function serveRoot(workspace: string): string {
  return path.join(path.resolve(workspace), ".kiln", "serve");
}

/** 同一个目标目录固定落到同一个状态文件，`--stop` 才不需要额外参数。 */
export function serveStatePath(workspace: string, target: string): string {
  const resolved = path.resolve(target);
  const slug = (path.basename(resolved) || "cast").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 32) || "cast";
  const digest = createHash("sha1").update(resolved).digest("hex").slice(0, 8);
  return path.join(serveRoot(workspace), `${slug}-${digest}.json`);
}

export function serveLogPath(workspace: string, target: string): string {
  return serveStatePath(workspace, target).replace(/\.json$/, ".log");
}

export async function readServeState(file: string): Promise<ServeState | null> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as ServeState;
    return typeof raw?.pid === "number" ? raw : null;
  } catch {
    return null;
  }
}

export async function writeServeState(file: string, state: ServeState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function clearServeState(file: string): Promise<void> {
  await rm(file, { force: true });
}

/** 只探测不发送信号：PID 被别人复用时会误判，所以调用方还要核对端口。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在但没权限发信号，仍算活着。
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 先礼后兵：SIGTERM → 轮询 → SIGKILL。
 * Windows 没有真正的信号，kill() 直接结束进程，两步等价。
 */
export async function stopProcess(pid: number, timeoutMs = 5000): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isProcessAlive(pid);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await wait(100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已经退出 */
  }
  await wait(100);
  return !isProcessAlive(pid);
}

export interface DetachedOptions {
  readonly execPath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly logFile: string;
}

/** 起一个脱离当前终端的子进程，返回它的 PID。stdout/stderr 落到日志文件。 */
export async function spawnDetached(options: DetachedOptions): Promise<number> {
  await mkdir(path.dirname(options.logFile), { recursive: true });
  const fd = openSync(options.logFile, "a");
  try {
    const child = spawn(options.execPath, [...options.args], {
      cwd: options.cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, KILN_DETACHED: "1" },
    });
    if (child.pid === undefined) throw new Error("子进程启动失败：没有拿到 PID");
    child.unref();
    return child.pid;
  } finally {
    // 父进程这一侧的句柄用完就关，子进程已复制自己的。
    closeSync(fd);
  }
}

/** 等一个文件出现（后台进程写完状态文件后才算真的起来了）。 */
export async function waitForFile(file: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readServeState(file);
    if (state !== null) return true;
    await wait(100);
  }
  return false;
}
