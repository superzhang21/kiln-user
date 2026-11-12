import { readFile } from "node:fs/promises";
import path from "node:path";

const DIMS = 256;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * 零依赖的轻量文本向量：字符 1–3 gram + 英文词，FNV-1a 哈希到固定维度。
 * 不是神经 embedding，但能覆盖中文近义片段与拼写变体，适合本地几十个应用的发现层。
 */
export function embed(text: string): number[] {
  const vector = new Array<number>(DIMS).fill(0);
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const segments = normalized.split(/[^\p{L}\p{N}]+/u).filter((item) => item !== "");
  const add = (gram: string, weight: number) => {
    const bucket = fnv1a(gram) % DIMS;
    vector[bucket] = (vector[bucket] ?? 0) + weight;
  };
  for (const segment of segments) {
    const chars = Array.from(segment);
    for (let size = 1; size <= 3; size += 1) {
      for (let start = 0; start + size <= chars.length; start += 1) {
        add(chars.slice(start, start + size).join(""), size === 1 ? 1 : size === 2 ? 1.6 : 2.2);
      }
    }
    if (/^[a-z][a-z0-9_-]+$/.test(segment) && segment.length > 1) add(segment, 1.2);
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  const length = Math.sqrt(norm) || 1;
  return vector.map((value) => value / length);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  const size = Math.min(a.length, b.length);
  for (let index = 0; index < size; index += 1) sum += (a[index] ?? 0) * (b[index] ?? 0);
  return sum;
}

export interface SemanticEntry {
  readonly id: string;
  readonly dir: string;
  readonly title: string;
  readonly summary: string;
  readonly intents: readonly string[];
  readonly tools: readonly string[];
  readonly vector: readonly number[];
}

export interface SemanticIndex {
  readonly schemaVersion: 1;
  readonly dims: number;
  readonly entries: readonly SemanticEntry[];
}

/** 把清单里所有「能被用户说出口」的字段拼成索引文本。 */
function searchable(manifest: Record<string, unknown>): string {
  const tools = Array.isArray(manifest.tools)
    ? (manifest.tools as { name?: string; purpose?: string }[]).map(
        (tool) => `${tool.name ?? ""} ${tool.purpose ?? ""}`,
      )
    : [];
  const actions = Array.isArray(manifest.actions)
    ? (manifest.actions as { name?: string; purpose?: string }[]).map(
        (action) => `${action.name ?? ""} ${action.purpose ?? ""}`,
      )
    : [];
  return [
    String(manifest.title ?? ""),
    String(manifest.summary ?? ""),
    ...(Array.isArray(manifest.intents) ? manifest.intents.map(String) : []),
    ...tools,
    ...actions,
  ].join("\n");
}

export async function buildSemanticIndex(dirs: readonly string[]): Promise<SemanticIndex> {
  const entries: SemanticEntry[] = [];
  for (const dir of dirs) {
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, "cast.json"), "utf8")) as Record<string, unknown>;
      const text = searchable(manifest);
      entries.push({
        id: String(manifest.id ?? ""),
        dir,
        title: String(manifest.title ?? ""),
        summary: String(manifest.summary ?? ""),
        intents: Array.isArray(manifest.intents) ? manifest.intents.map(String) : [],
        tools: Array.isArray(manifest.tools)
          ? (manifest.tools as { name?: string }[]).map((tool) => String(tool.name ?? ""))
          : [],
        vector: embed(text),
      });
    } catch {
      /* 损坏目录跳过，由调用方报告可用数量 */
    }
  }
  return { schemaVersion: 1, dims: DIMS, entries };
}

export interface SemanticHit {
  readonly entry: SemanticEntry;
  readonly score: number;
  readonly lexical: number;
}

export function semanticSearch(index: SemanticIndex, query: string, topK = 5): SemanticHit[] {
  const vector = embed(query);
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
  return index.entries
    .map((entry) => {
      const haystack =
        `${entry.title} ${entry.summary} ${entry.intents.join(" ")} ${entry.tools.join(" ")}`.toLowerCase();
      const lexical =
        tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0) / Math.max(1, tokens.length);
      return { entry, score: cosine(vector, entry.vector) * 0.7 + lexical * 0.3, lexical };
    })
    .filter((hit) => hit.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function indexToJson(index: SemanticIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}
