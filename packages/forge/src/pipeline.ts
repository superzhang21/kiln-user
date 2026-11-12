import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Issue } from "#grain";
import { loadCast, type LoadedCast } from "#pact";
import { buildBrief } from "#pact";
import { buildMcpTools } from "#pact";
import type { AgentAdapter } from "#pact";

export interface ForgeOptions {
  readonly dir: string;
  readonly outDir?: string;
  readonly adapters?: readonly AgentAdapter[];
}

export interface BatchFile {
  readonly name: string;
  readonly bytes: number;
}

export interface ForgeBatch {
  readonly castId: string;
  readonly version: string;
  readonly outDir: string;
  readonly files: readonly BatchFile[];
  readonly cost: { readonly tools: number; readonly bytes: number };
  readonly adapters: readonly string[];
}

export type ForgeResult = { ok: true; batch: ForgeBatch; cast: LoadedCast } | { ok: false; issues: readonly Issue[] };

async function write(dir: string, name: string, content: string): Promise<BatchFile> {
  const file = path.join(dir, name);
  await writeFile(file, content, "utf8");
  return { name, bytes: Buffer.byteLength(content, "utf8") };
}

/**
 * 「烧制」= 把源码变成可交付的契约产物。
 *
 * 这一版刻意不做打包器：产物是给人看和给 agent 读的契约（清单、工具表、紧凑说明），
 * 运行本身由宿主负责。把打包留出去，是为了不让构建管线绑死某个运行时。
 */
export async function forge(options: ForgeOptions): Promise<ForgeResult> {
  const loaded = await loadCast({ dir: options.dir });
  if (!loaded.ok) return { ok: false, issues: loaded.issues };

  const { cast } = loaded;
  const outDir = path.resolve(options.outDir ?? path.join(cast.dir, ".kiln", "out"));
  await mkdir(outDir, { recursive: true });

  const adapters = options.adapters ?? [];
  const files: BatchFile[] = [];

  files.push(await write(outDir, "cast.normalized.json", JSON.stringify(cast.manifest, null, 2)));

  const mcpTools = buildMcpTools(cast.catalog, { examples: true });
  files.push(await write(outDir, "tools.mcp.json", JSON.stringify({ tools: mcpTools }, null, 2)));

  files.push(await write(outDir, "brief.md", buildBrief(cast.catalog)));

  const exposures: Record<string, unknown> = {};
  for (const adapter of adapters) {
    const exposure = await adapter.expose(cast.catalog, {});
    exposures[adapter.id] = exposure.payload;
    files.push(await write(outDir, `exposure.${adapter.id}.json`, JSON.stringify(exposure.payload, null, 2)));
  }

  const batch: ForgeBatch = {
    castId: cast.manifest.id,
    version: cast.manifest.version,
    outDir,
    files,
    cost: cast.catalog.cost,
    adapters: adapters.map((a) => a.id),
  };

  files.push(await write(outDir, "batch.json", JSON.stringify(batch, null, 2)));
  return { ok: true, batch, cast };
}
