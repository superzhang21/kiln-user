import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CastManifest, Issue } from "#grain";
import { issue, validateManifest } from "#grain";
import { buildCatalog, compareSurface, type CastCatalog } from "./catalog.ts";
import { isFactory, isPact, type CastPact, type PactExport } from "./verbs.ts";
import { createRemotePact } from "./remote.ts";

export interface LoadedCast {
  readonly dir: string;
  readonly manifest: CastManifest;
  readonly pact: CastPact;
  readonly catalog: CastCatalog;
  readonly issues: readonly Issue[];
}

export interface LoadOptions {
  readonly dir: string;
  /** 开发模式：按 mtime 破缓存。 */
  readonly dev?: boolean;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 加载一个 cast。顺序是刻意的：先静态校验清单，再看入口是否存在，
 * 最后才 import。绝大多数错误在这一步就能报出来，不必真的跑起来。
 */
export async function loadCast(
  options: LoadOptions,
): Promise<{ ok: true; cast: LoadedCast } | { ok: false; issues: readonly Issue[] }> {
  const dir = path.resolve(options.dir);
  const manifestPath = path.join(dir, "cast.json");

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      issues: [
        issue({
          code: "KILN_MANIFEST_UNREADABLE",
          message: `读不到或解析失败: ${manifestPath}`,
          file: manifestPath,
          detail: { cause: error instanceof Error ? error.message : String(error) },
        }),
      ],
    };
  }

  const validated = validateManifest(raw, { file: manifestPath });
  if (!validated.manifest) return { ok: false, issues: validated.issues };
  const manifest = validated.manifest;

  if (manifest.entry.kind === "service") {
    try {
      new URL(manifest.entry.module);
    } catch {
      return {
        ok: false,
        issues: [
          issue({
            code: "KILN_ENTRY_MISSING",
            message: `service 型入口必须是完整 URL：${manifest.entry.module}`,
            file: manifestPath,
          }),
        ],
      };
    }
    const pact = createRemotePact(manifest);
    const surfaceIssues = compareSurface(manifest, pact);
    if (surfaceIssues.length > 0) return { ok: false, issues: surfaceIssues };
    return { ok: true, cast: { dir, manifest, pact, catalog: buildCatalog(manifest, pact), issues: [] } };
  }

  const entryPath = path.resolve(dir, manifest.entry.module);
  if (!(await exists(entryPath))) {
    return {
      ok: false,
      issues: [
        issue({
          code: "KILN_ENTRY_MISSING",
          message: `入口不存在: ${manifest.entry.module}`,
          file: manifestPath,
          detail: { expected: entryPath },
        }),
      ],
    };
  }

  let mod: Record<string, unknown>;
  try {
    const href = pathToFileURL(entryPath);
    // 开发模式按 mtime 破坏 ESM 缓存：Studio 改完 pact.ts 立即生效。
    if (options.dev) href.searchParams.set("v", String((await stat(entryPath)).mtimeMs));
    mod = (await import(href.href)) as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      issues: [
        issue({
          code: "KILN_ENTRY_EXPORT",
          message: `入口加载失败: ${manifest.entry.module}`,
          file: entryPath,
          detail: { cause: error instanceof Error ? error.message : String(error) },
        }),
      ],
    };
  }

  const exported = (mod.pact ?? mod.default) as PactExport | undefined;
  if (!exported) {
    return {
      ok: false,
      issues: [
        issue({
          code: "KILN_ENTRY_EXPORT",
          message: "入口没有导出 pact",
          file: entryPath,
          hint: "在入口模块里 `export const pact = { describe() {...}, invoke() {...} }`。",
        }),
      ],
    };
  }

  let pact: CastPact;
  try {
    pact = isFactory(exported) ? await exported(manifest) : exported;
  } catch (error) {
    return {
      ok: false,
      issues: [
        issue({
          code: "KILN_ENTRY_EXPORT",
          message: "pact 工厂执行失败",
          file: entryPath,
          detail: { cause: error instanceof Error ? error.message : String(error) },
        }),
      ],
    };
  }

  if (!isPact(pact)) {
    return {
      ok: false,
      issues: [
        issue({
          code: "KILN_ENTRY_EXPORT",
          message: "导出的对象没有 describe 方法",
          file: entryPath,
        }),
      ],
    };
  }

  const surfaceIssues = compareSurface(manifest, pact);
  if (surfaceIssues.length > 0) return { ok: false, issues: surfaceIssues };

  return {
    ok: true,
    cast: { dir, manifest, pact, catalog: buildCatalog(manifest, pact), issues: [] },
  };
}
