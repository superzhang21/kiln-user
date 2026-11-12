import { KilnError, toIssue } from "#grain";
import type { AgentBridge } from "#agents";
import type { Engine, EngineResult, EngineRunInput, EngineStep } from "./types.ts";
import { clampInt, normalizeRunInput } from "./types.ts";

/**
 * Pi 引擎：把决策循环外包给 Pi 的 Agent 运行时，工具仍然由 Kiln 提供。
 *
 * 设计要点：
 * 1. **零类型依赖**。Pi 的所有模块都通过变量化 `import()` 加载，Kiln 侧不 import
 *    任何 Pi 的类型，因此不装 Pi 也能通过类型检查，Pi 升级也不会把类型变更传导进来。
 * 2. **工具永远来自 bridge**。只使用 `pi-agent-core` 的 Agent，不使用 `pi-coding-agent`
 *    CLI 自带的 read/bash/edit/write —— 那些工具会以宿主权限直接操作文件与 shell，
 *    绕过能力网关，等于把 Kiln 的授权体系架空。
 * 3. **provider 由 Kiln 组装**。用 `api/openai-completions` 现成的流实现注册一个
 *    只指向 `--base-url` 的 provider，所以 Pi 只拿到一个模型端点，不读 Pi 自己的
 *    用户配置，也不会偷偷连别的地方。
 */

const PI_CORE = "@earendil-works/pi-agent-core";
const PI_AI = "@earendil-works/pi-ai";
const PI_OPENAI = "@earendil-works/pi-ai/api/openai-completions";

interface PiAgentLike {
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(input: string): Promise<void>;
  /** `prompt()` 只负责入队，必须等它才代表这一轮真的跑完。 */
  waitForIdle(): Promise<void>;
  abort(): void;
}

/** 装配好的 Pi 运行时。测试可以直接注入一个假的实现。 */
export interface PiRuntime {
  readonly Agent: new (options: unknown) => PiAgentLike;
  readonly models: { streamSimple: (...args: unknown[]) => unknown };
  readonly model: unknown;
}

export interface PiEngineOptions {
  readonly bridge: AgentBridge;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly maxTurns?: number;
  readonly system?: string;
  /** 注入装配好的运行时（测试用）；不传则动态加载 Pi。 */
  readonly runtime?: PiRuntime;
}

const DEFAULT_SYSTEM = [
  "你是一个编码代理，通过调用工具完成用户的任务。",
  "规则：",
  "1. 只使用提供的工具，不臆造工具名或参数。",
  "2. 改动尽量小；动手前先读取现状，不要猜测文件内容。",
  "3. 工具返回 ok=false 时，根据 error.code / hint 调整，不要重复同样的调用。",
  "4. 任务完成或无法继续时，用一段简洁中文说明做了什么、还剩什么，不要再调用工具。",
].join("\n");

/** 设置 KILN_DEBUG=1 时输出引擎装配与事件诊断，便于排查「引擎没动静」。 */
function debug(...parts: unknown[]): void {
  if (process.env.KILN_DEBUG) console.error("[kiln:pi]", ...parts);
}

function missingEngine(reason: string, detail?: Record<string, unknown>): KilnError {
  return new KilnError({
    code: "KILN_ENGINE_MISSING",
    message: `Pi 引擎不可用：${reason}`,
    hint: "运行 npm i -D @earendil-works/pi-agent-core 后重试，或用 --engine builtin 使用零依赖的内置引擎。",
    ...(detail ? { detail } : {}),
  });
}

/**
 * 探测 Pi 是否可用。只做 import 探测，不装配 provider，也不触网。
 */
export async function detectPi(): Promise<{ available: boolean; reason?: string }> {
  try {
    const spec: string = PI_CORE;
    await import(spec);
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const spec: string = PI_AI;
    await import(spec);
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { available: true };
}

/** 为一个 OpenAI 兼容端点装配 provider，返回可直接交给 Agent 的 model 与 streamFn。 */
async function loadPiRuntime(options: PiEngineOptions): Promise<PiRuntime> {
  if (options.runtime) return options.runtime;

  const coreSpec: string = PI_CORE;
  const aiSpec: string = PI_AI;
  const openaiSpec: string = PI_OPENAI;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  let core: any;
  let ai: any;
  let api: any;
  try {
    core = await import(coreSpec);
    ai = await import(aiSpec);
    api = await import(openaiSpec);
  } catch (error) {
    throw missingEngine(error instanceof Error ? error.message : String(error));
  }

  const models = ai.createModels();
  const provider = ai.createProvider({
    id: "kiln",
    name: "Kiln",
    baseUrl: options.baseUrl,
    auth: {
      apiKey: {
        name: "Kiln model endpoint",
        // Pi 的 resolve 契约是 { auth: ModelAuth }，不是裸的 ModelAuth。
        // Pi 拒绝空 auth（"No API key for provider"），所以未提供 key 时给一个占位值，
        // 让 Ollama / vLLM 这类不校验 Authorization 的本地端点也能跑。
        resolve: () => ({ auth: { apiKey: options.apiKey ?? "kiln" } }),
      },
    },
    models: [
      {
        id: options.model,
        name: options.model,
        provider: "kiln",
        api: "openai-completions",
        baseUrl: options.baseUrl,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
    api: { "openai-completions": api },
  });
  models.setProvider(provider);

  const model = models.getModel("kiln", options.model);
  if (!model) {
    throw missingEngine(`Pi 未能为该端点解析出模型 ${options.model}`, { baseUrl: options.baseUrl });
  }

  return {
    Agent: core.Agent,
    models: { streamSimple: (...args: unknown[]) => models.streamSimple(...args) },
    model,
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

function textOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: string; text?: string } => !!part && typeof part === "object")
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
  }
  return "";
}

function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === "object" && (message as { role?: string }).role === "assistant") {
      const text = textOf(message).trim();
      if (text !== "") return text;
    }
  }
  return "";
}

export function createPiEngine(options: PiEngineOptions): Engine {
  const maxTurns = clampInt(options.maxTurns, 1, 32, 8);
  const system = options.system ?? DEFAULT_SYSTEM;

  return {
    name: "pi",
    model: options.model,

    async run(input: EngineRunInput | string): Promise<EngineResult> {
      const { task, signal } = normalizeRunInput(input);
      const runtime = await loadPiRuntime(options);
      const tools = await options.bridge.listTools();

      const steps: EngineStep[] = [];
      let turn = 0;
      let abortedByLimit = false;
      let finalText = "";
      let failure: string | null = null;

      const piTools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        label: tool.name,
        execute: async (toolCallId: string, params: Record<string, unknown>) => {
          void toolCallId;
          try {
            const value = await options.bridge.callTool(tool.name, params ?? {});
            return {
              content: [{ type: "text", text: JSON.stringify(value ?? null) }],
              details: value ?? null,
            };
          } catch (error) {
            const issue = toIssue(error);
            return {
              content: [{ type: "text", text: JSON.stringify(issue) }],
              details: issue,
              isError: true,
            };
          }
        },
      }));

      const agent = new runtime.Agent({
        initialState: { systemPrompt: system, model: runtime.model, tools: piTools },
        streamFn: (...args: unknown[]) => {
          debug("streamFn 调用");
          const stream = runtime.models.streamSimple(...args);
          debug("streamFn 返回", (stream as { constructor?: { name?: string } })?.constructor?.name);
          return stream;
        },
      });
      debug("agent 已创建，工具数", piTools.length);

      const unsubscribe = agent.subscribe((raw) => {
        const event = raw as { type?: string; toolName?: string; isError?: boolean };
        if (event.type === "turn_start") {
          turn += 1;
          if (turn > maxTurns) {
            abortedByLimit = true;
            agent.abort();
          }
          return;
        }
        if (event.type === "tool_execution_end") {
          steps.push({ turn, tool: event.toolName ?? "unknown", ok: event.isError !== true, ms: 0 });
          return;
        }
        if (event.type === "agent_end") {
          const list = (raw as { messages?: unknown[] }).messages ?? [];
          const last = list[list.length - 1] as { stopReason?: string; errorMessage?: string } | undefined;
          if (last?.stopReason === "error") failure = last.errorMessage ?? "模型调用失败";
          finalText = lastAssistantText(list);
          debug("agent_end 消息数", list.length, "stopReason=", last?.stopReason, "error=", last?.errorMessage);
        }
      });

      const onAbort = (): void => {
        abortedByLimit = false;
        agent.abort();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        await agent.prompt(task);
        await agent.waitForIdle();
      } finally {
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
      }

      const stoppedBy: EngineResult["stoppedBy"] = failure
        ? "error"
        : abortedByLimit
          ? "maxTurns"
          : signal?.aborted === true
            ? "aborted"
            : "done";
      const turns = Math.min(turn, maxTurns);

      if (failure) {
        throw new KilnError({
          code: "KILN_MODEL_FAILED",
          message: `Pi 引擎调用模型失败：${failure}`,
          hint: "确认 --base-url 指向 OpenAI 兼容的 /v1 根路径、--model 存在；需要鉴权的端点请用 --api-key 或 KILN_MODEL_API_KEY。",
          detail: { engine: "pi", model: options.model, baseUrl: options.baseUrl },
        });
      }

      return {
        ok: stoppedBy === "done",
        output:
          stoppedBy === "done"
            ? finalText
            : stoppedBy === "maxTurns"
              ? `达到最大轮次 ${maxTurns}，任务未在预算内完成。`
              : "已取消。",
        turns,
        steps,
        stoppedBy,
        engine: "pi",
        model: options.model,
      };
    },
  };
}
