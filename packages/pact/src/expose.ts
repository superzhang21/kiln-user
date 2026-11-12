import type { CastCatalog } from "./catalog.ts";

/**
 * 适配器只负责「把同一份契约翻译成某个 agent 能吃的形状」。
 * 新增一个 agent 生态 = 新增一个适配器，不动内核。
 */
export interface AgentAdapter {
  readonly id: string;
  readonly label: string;
  /** 这个适配器需要什么形态的产物：结构化工具、一段提示词、还是一个服务端点。 */
  readonly produces: "tools" | "prompt" | "endpoint";
  /** 体积系数，用于估算塞进上下文要多少 token。 */
  readonly weight: number;
  expose(catalog: CastCatalog, options: ExposeOptions): Promise<AgentExposure>;
}

export interface ExposeOptions {
  /** 只暴露这些工具；不传即全部。 */
  readonly only?: readonly string[];
  /** 是否附带示例。带示例更省 agent 的探索轮次，但更占体积。 */
  readonly examples?: boolean;
}

export interface AgentExposure {
  readonly adapter: string;
  readonly kind: "tools" | "prompt" | "endpoint";
  readonly payload: unknown;
  readonly notes: readonly string[];
}

/** 极简的类型文字 → JSON Schema 片段。刻意不支持复杂组合，宁可让作者拆参数。 */
export function schemaForType(type: string): Record<string, unknown> {
  const t = type.trim().toLowerCase();
  if (t.endsWith("[]")) {
    return { type: "array", items: schemaForType(t.slice(0, -2)) };
  }
  if (t === "number" || t === "integer") return { type: "number" };
  if (t === "boolean") return { type: "boolean" };
  if (t === "object") return { type: "object" };
  if (t.startsWith("string|")) {
    return {
      type: "string",
      enum: t
        .slice(7)
        .split("|")
        .map((s) => s.trim()),
    };
  }
  return { type: "string" };
}

export function argsToSchema(args: Record<string, string> | undefined): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (args) {
    for (const [name, type] of Object.entries(args)) {
      const optional = type.trim().endsWith("?");
      properties[name] = schemaForType(optional ? type.trim().slice(0, -1) : type);
      if (!optional) required.push(name);
    }
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}
