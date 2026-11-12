import type { CastManifest, Shape } from "#grain";

export interface ShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface NetResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** 事务内的草稿视图：提交前不会落盘，抛错即回滚。 */
export interface StoreTx {
  read(key: string): unknown;
  write(key: string, value: unknown): void;
  drop(key: string): void;
  keys(): readonly string[];
}

export interface StoreHandle {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  drop(key: string): Promise<void>;
  keys(): Promise<string[]>;
  /**
   * 原子写入：所有改动先在内存草稿上完成，最后一次落盘；
   * 回调抛错时不写盘，等价于回滚。跨进程仍是 last-write-wins。
   */
  transaction?<T>(fn: (tx: StoreTx) => Promise<T> | T): Promise<T>;
}

export interface FileHandle {
  /** 路径必须以 {castdata} / {workspace} / {selected} / {home} 开头。 */
  read(target: string): Promise<string>;
  write(target: string, data: string): Promise<void>;
  list(target: string): Promise<string[]>;
}

/**
 * cast 触碰外部世界的唯一通道。没有 node:fs、没有裸 fetch——全部走这里，
 * 宿主才能在任何一次越界前拦下并给出理由。
 */
export interface CapabilityHandle {
  shell(command: string, args?: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ShellResult>;
  readonly store: StoreHandle;
  readonly file: FileHandle;
  net(url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<NetResult>;
  /** 把 {castdata} / {workspace} 这类占位符解析成真实路径。 */
  path(variable: string, rest?: string): string;
}

export interface CastContext {
  readonly castId: string;
  readonly callId: string;
  readonly startedAt: number;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly cap: CapabilityHandle;
  log(message: string): void;
}

export interface Observation {
  /** 业务字段，故意不收任意结构：宿主按字节预算裁剪并明确标记截断。 */
  readonly fields: Record<string, unknown>;
  readonly truncated?: readonly string[];
  readonly at: number;
}

export interface Intent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ActOutcome {
  readonly ok: boolean;
  /** act 之后的状态，让调用方一轮就拿到结果，不必再 observe 一次。 */
  readonly state?: Observation;
  readonly note?: string;
}

/**
 * 四动词契约。describe 必选，其余按 shape 组合：
 * task = describe + invoke，panel = describe + observe + act。
 * act 的返回值必须带 state，让调用方一轮拿到结果。
 */
export interface CastPact {
  describe(): CastDescription | Promise<CastDescription>;
  invoke?(tool: string, args: Record<string, unknown>, ctx: CastContext): Promise<unknown>;
  observe?(ctx: CastContext): Promise<Observation>;
  act?(intent: Intent, ctx: CastContext): Promise<ActOutcome>;
  /** 首次调用前初始化长连接、缓存或临时资源；不是动词，不影响 verbs 声明。 */
  onMount?(ctx: CastContext): Promise<void> | void;
  /** 宿主关闭、卸载或连接断开时清理资源；必须幂等。 */
  onUnmount?(ctx: CastContext): Promise<void> | void;
}

export interface CastDescription {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly summary: string;
  readonly shape: Shape;
  readonly intents: readonly string[];
}

export type PactFactory = (manifest: CastManifest) => CastPact | Promise<CastPact>;

/** 入口模块可以导出对象，也可以导出工厂。两者都接受，减少 agent 写错的概率。 */
export type PactExport = CastPact | PactFactory;

export function isFactory(value: PactExport): value is PactFactory {
  return typeof value === "function";
}

export function isPact(value: unknown): value is CastPact {
  if (value === null || typeof value !== "object") return false;
  return typeof (value as CastPact).describe === "function";
}
