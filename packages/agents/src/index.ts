import { KilnError } from "#grain";
import type { CastCatalog } from "#pact";
import { buildMcpTools } from "#pact";
import type { CastRunner } from "#host";

/**
 * Agent 通用接入层。
 *
 * 目标：让「任意 agent」都能用同一套契约调用 Kiln，而不是只认某一种生态。
 *
 * - `AgentBridge` 是进程内的统一接口：不依赖 MCP、不依赖网络，任何宿主代码都能直接调。
 * - 描述格式（mcp / openai / plain）只是同一份契约的不同投影，新增一个生态 = 加一个函数，
 *   不需要改内核，也不需要引入运行时依赖。
 */

export interface AgentTool {
  /** 完全限定名，形如 `<cast>__invoke__<tool>`。 */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly readOnly: boolean;
}

/** 进程内通用接口：任何 agent 宿主都可以直接持有并调用，不经过 MCP。 */
export interface AgentBridge {
  readonly id: string;
  listTools(): Promise<AgentTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** 一个可被 bridge 暴露的 cast：目录（catalog）+ 执行器（runner）。 */
export interface BridgeCast {
  readonly runner: CastRunner;
  readonly catalog: CastCatalog;
}

/** 把一份 catalog 摊平成通用工具描述。MCP 工具表本就是最接近通用形态的一种。 */
export function toolsOf(catalog: CastCatalog): AgentTool[] {
  return buildMcpTools(catalog).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnly: tool.annotations.readOnlyHint,
  }));
}

function findCast(casts: readonly BridgeCast[], name: string): BridgeCast | null {
  for (const cast of casts) {
    if (name.startsWith(`${cast.catalog.castId}__`)) return cast;
  }
  return null;
}

/**
 * 创建进程内 bridge。路由规则与 MCP 服务完全一致：
 * `<cast>__describe` / `<cast>__observe` / `<cast>__invoke__<tool>` / `<cast>__act__<action>`。
 */
export function createAgentBridge(casts: readonly BridgeCast[], id = "kiln"): AgentBridge {
  if (casts.length === 0) {
    throw new KilnError({ code: "KILN_ENTRY_MISSING", message: "没有可供 bridge 暴露的 cast" });
  }
  return {
    id,
    async listTools(): Promise<AgentTool[]> {
      const tools: AgentTool[] = [];
      for (const cast of casts) tools.push(...toolsOf(cast.catalog));
      return tools;
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      const cast = findCast(casts, name);
      if (!cast) {
        throw new KilnError({
          code: "KILN_PACT_MISMATCH",
          message: `未知工具: ${name}`,
          detail: { tool: name, known: casts.map((item) => item.catalog.castId) },
        });
      }
      const prefix = `${cast.catalog.castId}__`;
      if (name === `${prefix}describe`) return await cast.runner.describe();
      if (name === `${prefix}observe`) return (await cast.runner.observe()).observation;
      const invokePrefix = `${prefix}invoke__`;
      if (name.startsWith(invokePrefix)) {
        return (await cast.runner.invoke(name.slice(invokePrefix.length), args)).value;
      }
      const actPrefix = `${prefix}act__`;
      if (name.startsWith(actPrefix)) {
        return (await cast.runner.act({ ...args, type: name.slice(actPrefix.length) })).outcome;
      }
      throw new KilnError({
        code: "KILN_PACT_MISMATCH",
        message: `工具名不符合契约: ${name}`,
        detail: { tool: name, cast: cast.catalog.castId },
      });
    },
  };
}

/** OpenAI / 兼容端点要求的函数名：字母、数字、下划线、短横线，最长 64。 */
export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length <= 64 ? cleaned : cleaned.slice(0, 64);
}

export interface OpenAiTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** 投影成 OpenAI function-calling 的工具数组（DeepSeek / Ollama / vLLM 等同形）。 */
export function toOpenAiTools(catalog: CastCatalog, options: { readonly only?: readonly string[] } = {}): OpenAiTool[] {
  const only = options.only ? new Set(options.only) : null;
  return toolsOf(catalog)
    .filter((tool) => only === null || only.has(tool.name))
    .map((tool) => ({
      type: "function",
      function: {
        name: sanitizeToolName(tool.name),
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
}

export interface PlainToolset {
  readonly protocol: "kiln.agent/1";
  readonly cast: {
    readonly id: string;
    readonly title: string;
    readonly version: string;
    readonly summary: string;
  };
  readonly tools: readonly AgentTool[];
  readonly hints: readonly string[];
}

/** 与任何生态都无关的自描述：只要 agent 会发 HTTP / 读 JSON 就能用。 */
export function toPlainToolset(catalog: CastCatalog): PlainToolset {
  return {
    protocol: "kiln.agent/1",
    cast: {
      id: catalog.castId,
      title: catalog.title,
      version: catalog.version,
      summary: catalog.summary,
    },
    tools: toolsOf(catalog),
    hints: [
      "GET /tools/list 或 POST /tools/list 获取本清单。",
      'POST /tools/call，body 为 {"name":"<工具名>","arguments":{...}}。',
      "工具名形如 <cast>__invoke__<tool>；返回值即业务结果，失败时 ok=false 并带结构化 error。",
      "工具名、参数、返回值都来自 cast.json，不需要知道 Kiln 内部实现。",
    ],
  };
}

export type DescriptorFormat = "mcp" | "openai" | "plain";

export function describeFormats(): readonly DescriptorFormat[] {
  return ["mcp", "openai", "plain"];
}

/** 按目标格式生成描述载荷。未知格式由调用方先行校验。 */
export function describeCatalog(catalog: CastCatalog, format: DescriptorFormat): unknown {
  if (format === "mcp") return { tools: buildMcpTools(catalog) };
  if (format === "openai") return { tools: toOpenAiTools(catalog) };
  return toPlainToolset(catalog);
}
