import { KilnError, toIssue } from "#grain";
import type { AgentBridge, AgentTool } from "#agents";
import type { Engine, EngineResult, EngineRunInput, EngineStep } from "./types.ts";
import { clampInt, normalizeRunInput } from "./types.ts";

/**
 * 内置引擎：零依赖的最小工具循环。
 *
 * 只用全局 `fetch`，不引入任何运行时依赖；`chat` 可注入，测试时不触网。
 * 它的价值不是「够强」，而是「永远在」——任何环境都能跑，作为兜底与默认。
 */

export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCalls?: readonly ChatToolCall[];
  readonly toolCallId?: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly unknown[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface ChatResponse {
  readonly content: string | null;
  readonly toolCalls: readonly ChatToolCall[];
}

export type ChatFn = (request: ChatRequest) => Promise<ChatResponse>;

export interface ProviderConfig {
  /** 例如 https://api.openai.com/v1 、https://api.deepseek.com/v1 、http://127.0.0.1:11434/v1 。 */
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
}

function wireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId ?? "" };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

interface WireChoice {
  readonly message?: {
    readonly content?: string | null;
    readonly tool_calls?: readonly {
      readonly id?: string;
      readonly function?: { readonly name?: string; readonly arguments?: string };
    }[];
  };
}

/** 创建一个 OpenAI 兼容的 chat 实现，使用全局 fetch，不引入任何依赖。 */
export function createOpenAiChat(provider: ProviderConfig): ChatFn {
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return async (request: ChatRequest): Promise<ChatResponse> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(wireMessage),
      tools: request.tools,
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 800);
      throw new KilnError({
        code: "KILN_MODEL_FAILED",
        message: `模型端点返回 HTTP ${response.status}`,
        hint: "确认 baseUrl 指向 OpenAI 兼容的 /v1 根路径、model 名称存在、apiKey 有效。",
        detail: { endpoint, status: response.status, body: detail },
      });
    }
    const data = (await response.json()) as { choices?: readonly WireChoice[] };
    const message = data.choices?.[0]?.message;
    const toolCalls = (message?.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    }));
    return { content: message?.content ?? null, toolCalls };
  };
}

export interface BuiltinEngineOptions {
  readonly bridge: AgentBridge;
  readonly provider: ProviderConfig;
  /** 注入自定义 chat；不传则使用 OpenAI 兼容实现。 */
  readonly chat?: ChatFn;
  /** 最多几轮工具循环，默认 8，硬上限 32。 */
  readonly maxTurns?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly system?: string;
}

const DEFAULT_SYSTEM = [
  "你是一个编码代理，通过调用工具完成用户的任务。",
  "规则：",
  "1. 只使用提供的工具，不臆造工具名或参数。",
  "2. 改动尽量小；动手前先读取现状，不要猜测文件内容。",
  "3. 工具返回 ok=false 时，根据 error.code / hint 调整，不要重复同样的调用。",
  "4. 任务完成或无法继续时，用一段简洁中文说明做了什么、还剩什么，不要再调用工具。",
].join("\n");

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* 非法 JSON 交给业务层报参数错误 */
  }
  return {};
}

/** 把 bridge 的工具投影成 OpenAI function-calling 形状。 */
export function toWireTools(tools: readonly AgentTool[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

export function createBuiltinEngine(options: BuiltinEngineOptions): Engine {
  const chat = options.chat ?? createOpenAiChat(options.provider);
  const maxTurns = clampInt(options.maxTurns, 1, 32, 8);
  const system = options.system ?? DEFAULT_SYSTEM;
  const model = options.provider.model;

  return {
    name: "builtin",
    model,

    async run(input: EngineRunInput | string): Promise<EngineResult> {
      const { task, signal } = normalizeRunInput(input);
      const tools: AgentTool[] = await options.bridge.listTools();
      const wireTools = toWireTools(tools);
      const messages: ChatMessage[] = [
        { role: "system", content: system },
        { role: "user", content: task },
      ];
      const steps: EngineStep[] = [];
      let turn = 0;

      while (turn < maxTurns) {
        if (signal?.aborted) {
          return { ok: false, output: "已取消。", turns: turn, steps, stoppedBy: "aborted", engine: "builtin", model };
        }
        turn += 1;
        const response = await chat({
          model,
          messages,
          tools: wireTools,
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        });

        if (response.toolCalls.length === 0) {
          return {
            ok: true,
            output: response.content ?? "",
            turns: turn,
            steps,
            stoppedBy: "done",
            engine: "builtin",
            model,
          };
        }

        messages.push({ role: "assistant", content: response.content ?? "", toolCalls: response.toolCalls });
        for (const call of response.toolCalls) {
          const started = Date.now();
          let ok = true;
          let payload: string;
          try {
            const value = await options.bridge.callTool(call.name, parseArgs(call.arguments));
            payload = JSON.stringify(value);
          } catch (error) {
            ok = false;
            payload = JSON.stringify(toIssue(error));
          }
          steps.push({ turn, tool: call.name, ok, ms: Date.now() - started });
          messages.push({ role: "tool", content: payload, toolCallId: call.id });
        }
      }

      return {
        ok: false,
        output: `达到最大轮次 ${maxTurns}，任务未在预算内完成。`,
        turns: maxTurns,
        steps,
        stoppedBy: "maxTurns",
        engine: "builtin",
        model,
      };
    },
  };
}
