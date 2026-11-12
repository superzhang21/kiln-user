import type { AgentAdapter, AgentExposure, ExposeOptions } from "../expose.ts";
import type { CastCatalog } from "../catalog.ts";

/**
 * 把整份契约压成一段可直接放进 system prompt 的文本。
 *
 * 这是最省 token 的一条路径：没有 JSON 结构、没有 schema 重复，
 * 一个工具一行，跟一条真实示例。适合上下文紧张的 agent。
 */
export function buildBrief(catalog: CastCatalog, options: ExposeOptions = {}): string {
  const only = options.only ? new Set(options.only) : null;
  const tools = only ? catalog.tools.filter((t) => only.has(t.name)) : catalog.tools;
  const withExamples = options.examples !== false;

  const lines: string[] = [];
  lines.push(`## ${catalog.title}（${catalog.castId}@${catalog.version}）`);
  lines.push(catalog.summary);
  if (catalog.intents.length > 0) lines.push(`适用: ${catalog.intents.join(" / ")}`);

  if (tools.length > 0) {
    lines.push("");
    lines.push("### 可调用");
    for (const tool of tools) {
      const params = tool.args
        ? Object.entries(tool.args)
            .map(([k, v]) => `${k}:${v}`)
            .join(", ")
        : "";
      lines.push(`- ${tool.name}(${params}) — ${tool.purpose}`);
      if (withExamples && tool.examples[0]) {
        const ex = tool.examples[0];
        lines.push(`  例: ${JSON.stringify(ex.call)} → ${JSON.stringify(ex.result)}`);
      }
    }
  }

  if (catalog.actions.length > 0) {
    lines.push("");
    lines.push("### 可推进");
    for (const action of catalog.actions) {
      const params = action.args?.join(", ") ?? "";
      lines.push(`- ${action.name}(${params}) — ${action.purpose}`);
    }
  }

  if (catalog.shape === "panel") {
    lines.push("");
    lines.push("先 observe 读当前状态，再 act 推进；act 内部会自行校验，无效意图会被拒绝且状态不变。");
  }

  return lines.join("\n");
}

export const briefAdapter: AgentAdapter = {
  id: "brief",
  label: "紧凑提示词",
  produces: "prompt",
  weight: 0.45,
  async expose(catalog: CastCatalog, options: ExposeOptions): Promise<AgentExposure> {
    const text = buildBrief(catalog, options);
    return {
      adapter: "brief",
      kind: "prompt",
      payload: { text },
      notes: [
        `比 MCP 结构省约 ${Math.round((1 - 0.45) * 100)}% 体积，代价是参数类型只剩文字描述。`,
        "适合多 cast 并存、上下文吃紧的调度场景。",
      ],
    };
  },
};
