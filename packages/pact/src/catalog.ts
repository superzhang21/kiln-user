import type { ActionDecl, CastManifest, Issue, ToolDecl } from "#grain";
import { issue } from "#grain";
import type { CastPact } from "./verbs.ts";

export interface CastCatalog {
  readonly castId: string;
  readonly version: string;
  readonly title: string;
  readonly summary: string;
  readonly intents: readonly string[];
  readonly shape: CastManifest["shape"];
  readonly verbs: readonly string[];
  readonly tools: readonly ToolDecl[];
  readonly actions: readonly ActionDecl[];
  /** 给调度器做取舍用的：把这份目录整体塞进上下文要多少字节。 */
  readonly cost: { readonly tools: number; readonly bytes: number };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * 把「声明的」和「实现的」对齐。这一步是刻意的：清单可以被手写错，
 * 实现也可以漂移，两者只有在这里对上，导出的契约才可信。
 */
export function compareSurface(manifest: CastManifest, pact: CastPact): Issue[] {
  const out: Issue[] = [];

  for (const verb of manifest.verbs) {
    if (verb === "describe") continue;
    const fn = (pact as unknown as Record<string, unknown>)[verb];
    if (typeof fn !== "function") {
      out.push(
        issue({
          code: "KILN_PACT_MISSING_VERB",
          message: `清单声明了 ${verb}，pact 未实现`,
          detail: { verb, cast: manifest.id },
        }),
      );
    }
  }

  if (manifest.verbs.includes("invoke") && manifest.tools.length === 0) {
    out.push(
      issue({
        code: "KILN_VERB_ORPHAN",
        message: "声明了 invoke 但清单没有工具",
        detail: { cast: manifest.id },
      }),
    );
  }

  if (manifest.verbs.includes("act") && manifest.actions.length === 0) {
    out.push(
      issue({
        code: "KILN_VERB_ORPHAN",
        message: "声明了 act 但清单没有动作",
        detail: { cast: manifest.id },
      }),
    );
  }

  const extra: string[] = [];
  for (const verb of ["invoke", "observe", "act"] as const) {
    const fn = (pact as unknown as Record<string, unknown>)[verb];
    if (typeof fn === "function" && !manifest.verbs.includes(verb)) extra.push(verb);
  }
  if (extra.length > 0) {
    out.push(
      issue({
        code: "KILN_PACT_MISMATCH",
        message: "pact 实现了清单未声明的动词",
        hint: `把 ${extra.join(" / ")} 补进 cast.json 的 verbs，或者删掉实现。未声明的动词不会被导出。`,
        detail: { cast: manifest.id, undeclared: extra },
      }),
    );
  }

  return out;
}

export function buildCatalog(manifest: CastManifest, pact: CastPact): CastCatalog {
  void pact;
  return {
    castId: manifest.id,
    version: manifest.version,
    title: manifest.title,
    summary: manifest.summary,
    intents: manifest.intents,
    shape: manifest.shape,
    verbs: manifest.verbs,
    tools: manifest.tools,
    actions: manifest.actions,
    cost: {
      tools: manifest.tools.length,
      bytes: byteLength({
        title: manifest.title,
        summary: manifest.summary,
        tools: manifest.tools,
        actions: manifest.actions,
      }),
    },
  };
}

/** 只保留调用方刚好需要的那些工具。用于按任务裁剪上下文，而不是全量塞入。 */
export function narrow(catalog: CastCatalog, toolNames: readonly string[]): CastCatalog {
  const keep = new Set(toolNames);
  const tools = catalog.tools.filter((t) => keep.has(t.name));
  return {
    ...catalog,
    tools,
    cost: { tools: tools.length, bytes: byteLength({ title: catalog.title, tools }) },
  };
}
