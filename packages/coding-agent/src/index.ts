import type { AgentBridge } from "#agents";
import { createBuiltinEngine } from "./builtin.ts";
import type { BuiltinEngineOptions, ChatFn, ProviderConfig } from "./builtin.ts";
import { createPiEngine, detectPi } from "./pi.ts";
import type { PiEngineOptions, PiRuntime } from "./pi.ts";
import type { Engine, EngineName, EngineResult, EngineStep, EngineStopReason } from "./types.ts";
import { normalizeRunInput } from "./types.ts";

/**
 * 可选的模型代理（coding agent）。
 *
 * 定位：仓库自带一个「会用工具干活的代理」，但**默认关闭**，且不绑定任何厂商或运行时。
 * 它由两部分组成：
 *
 * - **决策器（引擎）**：负责「下一步调什么工具」。可以用内置循环（零依赖），也可以
 *   换成 Pi 的 Agent 运行时（需要额外安装，能力更强）。
 * - **工具面（bridge）**：永远由 Kiln 提供，所有调用都走能力网关与审计。
 *
 * 这条边界意味着：换引擎不会改变「谁能调什么」，也不会让任何引擎绕过授权。
 */

export type { Engine, EngineName, EngineResult, EngineStep, EngineStopReason };
export type { BuiltinEngineOptions, ChatFn, ProviderConfig };
export type { ChatMessage, ChatRequest, ChatResponse, ChatToolCall } from "./builtin.ts";
export type { PiEngineOptions, PiRuntime };
export { createBuiltinEngine, createOpenAiChat, toWireTools } from "./builtin.ts";
export { createPiEngine, detectPi } from "./pi.ts";
export { normalizeRunInput } from "./types.ts";

/** 兼容旧名字：内置引擎就是原来的 coding agent。 */
export type CodingAgentResult = EngineResult;
export type CodingAgentStep = EngineStep;
export type CodingAgentOptions = BuiltinEngineOptions;

export interface EngineOptions {
  readonly bridge: AgentBridge;
  readonly provider: ProviderConfig;
  /** `auto` 时探测 Pi，不可用则回落到内置引擎。默认 `auto`。 */
  readonly engine?: EngineName;
  readonly maxTurns?: number;
  readonly system?: string;
  /** 仅内置引擎使用。 */
  readonly chat?: ChatFn;
  /** 仅 Pi 引擎使用，测试注入装配好的运行时。 */
  readonly runtime?: PiRuntime;
}

/** 把 `auto` 解析成具体引擎：装了 Pi 就用 Pi，没装就用内置的。 */
export async function resolveEngineName(name: EngineName = "auto"): Promise<"builtin" | "pi"> {
  if (name === "builtin" || name === "pi") return name;
  const probe = await detectPi();
  return probe.available ? "pi" : "builtin";
}

/**
 * 按名字创建引擎。
 *
 * 注意：`pi` 是硬选择 —— 显式要 Pi 但没装时会抛 `KILN_ENGINE_MISSING`，
 * 不会静默回落，避免「以为在用 Pi，其实跑的是内置循环」。
 */
export async function createEngine(options: EngineOptions): Promise<Engine> {
  const name = await resolveEngineName(options.engine);
  if (name === "pi") {
    return createPiEngine({
      bridge: options.bridge,
      baseUrl: options.provider.baseUrl,
      model: options.provider.model,
      ...(options.provider.apiKey !== undefined ? { apiKey: options.provider.apiKey } : {}),
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.system !== undefined ? { system: options.system } : {}),
      ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    });
  }
  return createBuiltinEngine({
    bridge: options.bridge,
    provider: options.provider,
    ...(options.chat !== undefined ? { chat: options.chat } : {}),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.system !== undefined ? { system: options.system } : {}),
  });
}

/** 兼容入口：等价于 `createBuiltinEngine`。新代码建议直接用 `createEngine`。 */
export function createCodingAgent(options: BuiltinEngineOptions): { run(task: string): Promise<EngineResult> } {
  const engine = createBuiltinEngine(options);
  return {
    run: (task: string) => engine.run(normalizeRunInput(task)),
  };
}
