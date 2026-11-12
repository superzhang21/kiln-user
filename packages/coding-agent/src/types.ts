/**
 * 引擎抽象。
 *
 * 「引擎」只负责一件事：把一句任务描述变成一串工具调用，并把工具调用的执行
 * 交给外部传入的 `bridge`。引擎**不拥有工具**，工具永远由 Kiln 的能力网关提供。
 *
 * 这条边界是整个模块的设计前提：无论用内置循环还是 Pi，工具的可达性、授权、
 * 审计都留在 Kiln 内部，引擎只是一个可以随时替换的「决策器」。
 */

export interface EngineStep {
  readonly turn: number;
  readonly tool: string;
  readonly ok: boolean;
  readonly ms: number;
}

/** 停止原因。`aborted` 表示被外部取消或触发轮次上限后主动中止。 */
export type EngineStopReason = "done" | "maxTurns" | "aborted" | "error";

export interface EngineResult {
  readonly ok: boolean;
  readonly output: string;
  readonly turns: number;
  readonly steps: readonly EngineStep[];
  readonly stoppedBy: EngineStopReason;
  /** 实际使用的引擎名，例如 `builtin` / `pi`。 */
  readonly engine: string;
  readonly model: string;
}

export interface EngineRunInput {
  readonly task: string;
  readonly signal?: AbortSignal;
}

/** 一个可替换的决策器。 */
export interface Engine {
  readonly name: string;
  readonly model: string;
  run(input: EngineRunInput | string): Promise<EngineResult>;
}

export type EngineName = "auto" | "builtin" | "pi";

export function normalizeRunInput(input: EngineRunInput | string): EngineRunInput {
  return typeof input === "string" ? { task: input } : input;
}

/** 把任意输入夹到 [min, max]，非法值回退默认。 */
export function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const requested = value ?? fallback;
  if (!Number.isFinite(requested)) return fallback;
  return Math.min(Math.max(Math.trunc(requested), min), max);
}
