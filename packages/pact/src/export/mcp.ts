import type { AgentAdapter, AgentExposure, ExposeOptions } from "../expose.ts";
import { argsToSchema } from "../expose.ts";
import type { CastCatalog } from "../catalog.ts";

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean };
}

/**
 * 输出标准 MCP tools/list 载荷。这是最常见的一条接入路径：
 * 任何说 MCP 的客户端都能直接用，不需要知道 Kiln 存在。
 */
export function buildMcpTools(catalog: CastCatalog, options: ExposeOptions = {}): McpTool[] {
  const only = options.only ? new Set(options.only) : null;
  const tools = only ? catalog.tools.filter((t) => only.has(t.name)) : catalog.tools;
  const isIncluded = (name: string) => only === null || only.has(name);

  const invokeTools = tools.map((tool) => {
    const example = options.examples === false ? undefined : tool.examples[0];
    const desc = example ? `${tool.purpose}\n\n示例入参: ${JSON.stringify(example.call)}` : tool.purpose;
    return {
      name: `${catalog.castId}__invoke__${tool.name}`,
      description: desc,
      inputSchema: argsToSchema(tool.args),
      annotations: { readOnlyHint: false },
    };
  });

  const describeTools: McpTool[] = isIncluded("describe")
    ? [
        {
          name: `${catalog.castId}__describe`,
          description: `读取 ${catalog.title} 的静态能力说明`,
          inputSchema: argsToSchema(undefined),
          annotations: { readOnlyHint: true },
        },
      ]
    : [];

  const observeTools: McpTool[] =
    catalog.verbs.includes("observe") && isIncluded("observe")
      ? [
          {
            name: `${catalog.castId}__observe`,
            description: `读取 ${catalog.title} 的当前状态`,
            inputSchema: argsToSchema(undefined),
            annotations: { readOnlyHint: true },
          },
        ]
      : [];

  const actTools: McpTool[] = catalog.verbs.includes("act")
    ? catalog.actions
        .filter((action) => isIncluded(action.name))
        .map((action) => {
          const args = action.args ?? [];
          return {
            name: `${catalog.castId}__act__${action.name}`,
            description: action.purpose,
            inputSchema: {
              type: "object",
              properties: Object.fromEntries(args.map((name) => [name, {}])),
              ...(args.length > 0 ? { required: args } : {}),
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false },
          };
        })
    : [];

  return [...describeTools, ...invokeTools, ...observeTools, ...actTools];
}

export const mcpAdapter: AgentAdapter = {
  id: "mcp",
  label: "MCP tools/list",
  produces: "tools",
  weight: 1,
  async expose(catalog: CastCatalog, options: ExposeOptions): Promise<AgentExposure> {
    const tools = buildMcpTools(catalog, options);
    return {
      adapter: "mcp",
      kind: "tools",
      payload: { tools },
      notes: [
        `工具名以 ${catalog.castId}__ 为前缀，并区分 describe / invoke / observe / act。`,
        "示例被折进 description，客户端不必额外请求就能看到真实入参。",
      ],
    };
  },
};
