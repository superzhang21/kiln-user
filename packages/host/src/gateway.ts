import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { KilnError, PATH_VARS, issue, type Grants } from "#grain";
import type { CapabilityHandle, CastContext, FileHandle, NetResult, ShellResult, StoreHandle, StoreTx } from "#pact";
import type { ResolvedGrants } from "./policy.ts";
import { clip, diffText, type AuditRecord } from "./audit.ts";

export interface GatewayOptions {
  readonly castId: string;
  readonly root: string;
  readonly dataDir: string;
  readonly workspace: string;
  readonly resolved: ResolvedGrants;
  readonly grants: Grants;
  readonly timeoutMs?: number;
  readonly logger?: (line: string) => void;
  /** 拒绝事件上报给执行器，由它在动词返回后统一抛出。 */
  readonly onDeny?: (issue: import("#grain").Issue) => void;
  /** 能力流水账：记录每一次 shell / net / file / store 调用与拦截原因。 */
  readonly audit?: (record: AuditRecord) => void;
}

const DEFAULT_TIMEOUT = 20_000;

/** 同进程内多个 runner 共享一份 store.json 时，用版本号让各自的缓存失效。 */
const STORE_VERSIONS = new Map<string, number>();

/** Windows 上文件可能被索引或安全软件短暂占用，短重试后再把错误抛出去。 */
async function writeStoreFile(file: string, body: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await writeFile(file, body, "utf8");
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

/**
 * 能力网关。所有副作用都从这里出去，因此「能不能做」和「怎么做」永远在同一个地方，
 * 不存在绕过检查的第二条路。
 */
export class CapabilityGateway {
  readonly #opts: GatewayOptions;
  readonly #store: FileStore;

  constructor(options: GatewayOptions) {
    this.#opts = options;
    this.#store = new FileStore(path.join(options.dataDir, "store.json"));
  }

  /**
   * 拒绝的唯一出口：先记账再抛。cast 可以 catch 掉异常当成业务失败，
   * 但账本改不了——执行器会在动词返回后用它覆盖结果。
   */
  #deny(input: Parameters<typeof issue>[0]): never {
    const built = issue(input);
    this.#opts.onDeny?.(built);
    throw KilnError.fromIssue(built);
  }

  /** 审计是旁路：记录失败绝不能影响 cast 的正常执行。 */
  #emit(record: Omit<AuditRecord, "at" | "castId">): void {
    if (!this.#opts.audit) return;
    try {
      this.#opts.audit({ at: new Date().toISOString(), castId: this.#opts.castId, ...record });
    } catch {
      /* 忽略审计写入失败 */
    }
  }

  async #run<T>(
    capability: AuditRecord["capability"],
    method: string,
    target: string,
    action: () => Promise<T>,
    diff?: () => string,
  ): Promise<T> {
    const started = Date.now();
    try {
      const value = await action();
      const patch = diff?.();
      this.#emit({
        capability,
        method,
        target: clip(target),
        ok: true,
        ms: Date.now() - started,
        ...(patch ? { diff: patch } : {}),
      });
      return value;
    } catch (error) {
      this.#emit({
        capability,
        method,
        target: clip(target),
        ok: false,
        ms: Date.now() - started,
        code: (error as { code?: string }).code ?? "KILN_CALL_FAILED",
      });
      throw error;
    }
  }

  /** 理由统一来自策略解析结果，调用方不自己拼字符串——这些文案要能直接给用户看。 */
  assert(cap: string, detail?: Record<string, unknown>): void {
    const scope = this.#opts.resolved[cap];
    if (!scope) {
      this.#deny({
        code: "KILN_CAP_DENIED",
        message: `cast 未声明能力 ${cap}`,
        detail: { cast: this.#opts.castId, capability: cap, reason: "清单 grants 中没有该能力" },
      });
    }
    if (scope && scope.decision === "deny") {
      this.#deny({
        code: "KILN_CAP_DENIED",
        message: `能力 ${cap} 被拒绝`,
        detail: { cast: this.#opts.castId, capability: cap, reason: scope.reason, ...detail },
      });
    }
    // ask 一律降级为拒绝并给出可执行原因：静默放行等于把 ask 当 allow。
    if (scope && (scope as { decision?: string }).decision === "ask") {
      this.#deny({
        code: "KILN_CAP_ASK",
        message: `能力 ${cap} 需要人工确认`,
        hint: "宿主策略为 ask；非交互环境请预先授权，或改用只读方案。",
        detail: { cast: this.#opts.castId, capability: cap, ...detail },
      });
    }
  }

  #allowList(cap: string): Set<string> {
    const scope = this.#opts.resolved[cap];
    return new Set(scope?.allowed ?? []);
  }

  resolvePath(variable: string, rest = ""): string {
    const base = this.#opts;
    const roots: Record<string, string> = {
      "{castdata}": base.dataDir,
      "{workspace}": base.workspace,
      "{home}": process.env.USERPROFILE ?? process.env.HOME ?? base.workspace,
    };
    const prefix = PATH_VARS.find((v) => variable === v || variable.startsWith(`${v}/`));
    if (prefix === "{selected}") {
      throw new KilnError({
        code: "KILN_GRANT_PATHVAR",
        message: "{selected} 需要宿主注入用户选择的路径，当前宿主尚未实现该占位符",
        hint: "改用 {castdata} / {workspace} / {home}，或由宿主实现 {selected} 的路径注入。",
        detail: { variable, known: PATH_VARS },
      });
    }
    const root = prefix ? roots[prefix] : undefined;
    if (!prefix || !root) {
      throw new KilnError({
        code: "KILN_GRANT_PATHVAR",
        message: `无法解析路径变量 ${variable}`,
        detail: { variable, known: PATH_VARS },
      });
    }
    const tail = rest || variable.slice(prefix.length).replace(/^[/\\]/, "");
    const resolvedRoot = path.resolve(root);
    const joined = path.resolve(resolvedRoot, tail);
    // 不用 startsWith 判断越界：`{castdata}/../etc` 拼出的字符串仍以 `{castdata}` 开头，
    // 但 relative 能看出它其实跑到了根目录外。
    const relative = path.relative(resolvedRoot, joined);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new KilnError({
        code: "KILN_GRANT_PATHVAR",
        message: "路径越界",
        detail: { variable, resolved: joined },
      });
    }
    return joined;
  }

  /**
   * 清单声明的 file 读写范围是「路径前缀」，不只是占位符。
   * `{castdata}/exports` 只能覆盖 exports/ 下的路径，`exports2/` 这类同名前缀不算命中。
   * 早期版本用 startsWith 判断，exports2 曾被放行——那是个真实越权。
   */
  #fileAllowed(kind: "read" | "write", target: string): string {
    const variable = PATH_VARS.find((v) => target === v || target.startsWith(`${v}/`));
    if (!variable) {
      throw new KilnError({
        code: "KILN_GRANT_PATHVAR",
        message: `路径必须以占位符开头: ${target}`,
        detail: { target, known: PATH_VARS },
      });
    }
    const list = this.#opts.grants.file?.[kind] ?? [];
    const normalize = (value: string) => value.replace(/\\/g, "/");
    const tail = normalize(target.slice(variable.length)).replace(/^\//, "");
    const allowed = list.some((entry) => {
      if (!entry.startsWith(variable)) return false;
      const rest = entry.slice(variable.length);
      if (rest !== "" && !/^[/\\]/.test(rest)) return false;
      const declared = normalize(rest).replace(/^\//, "");
      if (declared === "") return true;
      return tail === declared || tail.startsWith(`${declared}/`);
    });
    if (!allowed) {
      this.#deny({
        code: "KILN_CAP_DENIED",
        message: `${kind === "read" ? "读取" : "写入"}未授权: ${target}`,
        detail: {
          capability: "file",
          scope: kind,
          declared: list,
          reason: `grants.file.${kind} 未覆盖 ${target}`,
        },
      });
    }
    return this.resolvePath(target);
  }

  createHandle(): CapabilityHandle {
    const self = this;
    return {
      async shell(command: string, args: string[] = [], opts = {}): Promise<ShellResult> {
        return await self.#run("shell", "exec", [command, ...args].join(" "), async () => {
          self.assert("shell", { command });
          const allow = self.#allowList("shell");
          if (allow.size > 0 && !allow.has(command)) {
            self.#deny({
              code: "KILN_CAP_DENIED",
              message: `命令 ${command} 不在白名单`,
              detail: { command, allowed: [...allow] },
            });
          }
          // args 走数组，不拼 shell 字符串——这是这条通道唯一安全的调用形式。
          return await new Promise<ShellResult>((resolve, reject) => {
            execFile(
              command,
              args,
              {
                cwd: opts.cwd ?? self.#opts.workspace,
                timeout: opts.timeoutMs ?? self.#opts.timeoutMs ?? DEFAULT_TIMEOUT,
                maxBuffer: 8 * 1024 * 1024,
                windowsHide: true,
              },
              (error, stdout, stderr) => {
                const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
                if (err && err.code === "ETIMEDOUT") {
                  reject(new KilnError({ code: "KILN_CALL_TIMEOUT", detail: { command, args } }));
                  return;
                }
                // 非零退出码是正常结果，不是异常；让 cast 自己决定怎么处理。
                const exitCode = err ? (typeof err.code === "number" ? err.code : 1) : 0;
                resolve({
                  stdout: String(stdout ?? ""),
                  stderr: String(stderr ?? ""),
                  code: exitCode,
                });
              },
            );
          });
        });
      },

      get store(): StoreHandle {
        return {
          read: (key) =>
            self.#run("store", "read", key, async () => {
              self.assert("store");
              return await self.#store.read(key);
            }),
          write: (key, value) =>
            self.#run("store", "write", key, async () => {
              self.assert("store");
              await self.#store.write(key, value);
            }),
          drop: (key) =>
            self.#run("store", "drop", key, async () => {
              self.assert("store");
              await self.#store.drop(key);
            }),
          keys: () =>
            self.#run("store", "keys", "*", async () => {
              self.assert("store");
              return await self.#store.keys();
            }),
          transaction<T>(fn: (tx: StoreTx) => Promise<T> | T): Promise<T> {
            return self.#run("store", "transaction", "*", async () => {
              self.assert("store");
              return await self.#store.transaction(fn);
            });
          },
        };
      },

      get file(): FileHandle {
        return {
          read: (target) =>
            self.#run("file", "read", target, async () => await readFile(self.#fileAllowed("read", target), "utf8")),
          write: async (target, data) => {
            let before = "";
            await self.#run(
              "file",
              "write",
              target,
              async () => {
                const resolved = self.#fileAllowed("write", target);
                try {
                  before = await readFile(resolved, "utf8");
                } catch {
                  before = "";
                }
                await mkdir(path.dirname(resolved), { recursive: true });
                await writeFile(resolved, data, "utf8");
              },
              () => (before === "" ? "新增文件" : diffText(before, data)),
            );
          },
          list: (target) =>
            self.#run("file", "list", target, async () => await readdir(self.#fileAllowed("read", target))),
        };
      },

      async net(url: string, init = {}): Promise<NetResult> {
        let auditHost = url;
        try {
          auditHost = new URL(url).host;
        } catch {
          /* 非法 URL 交给下面的解析统一报错 */
        }
        return await self.#run("net", init.method ?? "GET", auditHost, async () => {
          self.assert("net", { url });
          let host: string;
          try {
            host = new URL(url).host;
          } catch {
            throw new KilnError({ code: "KILN_CALL_FAILED", message: `URL 不合法: ${url}`, detail: { url } });
          }
          const allow = self.#allowList("net");
          if (allow.size > 0 && !allow.has(host)) {
            self.#deny({
              code: "KILN_CAP_DENIED",
              message: `域名 ${host} 不在白名单`,
              detail: { host, allowed: [...allow] },
            });
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), self.#opts.timeoutMs ?? DEFAULT_TIMEOUT);
          try {
            const res = await fetch(url, {
              method: init.method ?? "GET",
              ...(init.body !== undefined ? { body: init.body } : {}),
              ...(init.headers !== undefined ? { headers: init.headers } : {}),
              signal: controller.signal,
            });
            const headers: Record<string, string> = {};
            res.headers.forEach((v, k) => {
              headers[k] = v;
            });
            return { status: res.status, headers, body: await res.text() };
          } finally {
            clearTimeout(timer);
          }
        });
      },

      path: (variable, rest) => self.resolvePath(variable, rest),
    };
  }

  createContext(callId: string, signal?: AbortSignal, log?: (line: string) => void): CastContext {
    const startedAt = Date.now();
    const controller = new AbortController();
    return {
      castId: this.#opts.castId,
      callId,
      startedAt,
      deadline: startedAt + (this.#opts.timeoutMs ?? DEFAULT_TIMEOUT),
      signal: signal ?? controller.signal,
      cap: this.createHandle(),
      log: (line: string) => (this.#opts.logger ?? log ?? (() => {}))(line),
    };
  }
}

class FileStore {
  readonly #file: string;
  #cache: Record<string, unknown> | null = null;
  #version = -1;
  #signature: string | null = null;
  /** 同一 store.json 的落盘串行化：Windows 上并发 writeFile 会 EBUSY。 */
  #writeChain: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async #stat(): Promise<string | null> {
    try {
      const info = await stat(this.#file);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return null;
    }
  }

  /**
   * 同一进程内多个 runner 各自持有缓存，另一进程也可能改写文件。
   * 版本号（同进程）+ mtime/size 签名（跨进程）任一变化就重读，避免读到过期状态。
   */
  async #load(): Promise<Record<string, unknown>> {
    if (this.#cache) {
      const version = STORE_VERSIONS.get(this.#file) ?? 0;
      if (this.#version === version && this.#signature === (await this.#stat())) return this.#cache;
      this.#cache = null;
    }
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#cache = {};
        this.#version = STORE_VERSIONS.get(this.#file) ?? 0;
        this.#signature = null;
        return this.#cache;
      }
      throw new KilnError({
        code: "KILN_CALL_FAILED",
        message: "读取持久化存储失败",
        detail: { file: this.#file, cause: error instanceof Error ? error.message : String(error) },
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new KilnError({
        code: "KILN_CALL_FAILED",
        message: "持久化存储不是合法 JSON",
        detail: { file: this.#file, cause: error instanceof Error ? error.message : String(error) },
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new KilnError({
        code: "KILN_CALL_FAILED",
        message: "持久化存储必须是 JSON 对象",
        detail: { file: this.#file },
      });
    }
    this.#cache = parsed as Record<string, unknown>;
    this.#version = STORE_VERSIONS.get(this.#file) ?? 0;
    this.#signature = await this.#stat();
    return this.#cache;
  }

  async #flush(data: Record<string, unknown>): Promise<void> {
    const job = this.#writeChain.then(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true });
      await writeStoreFile(this.#file, JSON.stringify(data, null, 2));
      // 提交后缓存必须指向同一份数据；否则事务的草稿落盘后，下一次读取仍拿旧缓存。
      this.#cache = data;
      this.#version = (STORE_VERSIONS.get(this.#file) ?? 0) + 1;
      STORE_VERSIONS.set(this.#file, this.#version);
      this.#signature = await this.#stat();
    });
    // 失败的写入不阻断后续作业，但会由调用方（write/drop）收到异常。
    this.#writeChain = job.catch(() => undefined);
    await job;
  }

  async read(key: string): Promise<unknown> {
    const data = await this.#load();
    return data[key] ?? null;
  }

  async write(key: string, value: unknown): Promise<void> {
    const data = await this.#load();
    data[key] = value;
    await this.#flush(data);
  }

  async drop(key: string): Promise<void> {
    const data = await this.#load();
    delete data[key];
    await this.#flush(data);
  }

  async keys(): Promise<string[]> {
    return Object.keys(await this.#load());
  }

  /**
   * 事务：所有改动先落在内存草稿，最后一次原子写；回调抛错则不落盘。
   * 写入队列本身串行，因此同一进程内的事务不会互相撕裂。
   */
  async transaction<T>(fn: (tx: StoreTx) => Promise<T> | T): Promise<T> {
    const draft = structuredClone(await this.#load()) as Record<string, unknown>;
    const tx: StoreTx = {
      read: (key) => draft[key] ?? null,
      write: (key, value) => {
        draft[key] = value;
      },
      drop: (key) => {
        delete draft[key];
      },
      keys: () => Object.keys(draft),
    };
    const result = await fn(tx);
    await this.#flush(draft);
    return result;
  }
}
