import { issue, type Issue } from "./error.ts";

export type Shape = "task" | "panel";
export type Verb = "describe" | "invoke" | "observe" | "act";

export const VERBS: readonly Verb[] = ["describe", "invoke", "observe", "act"];
export const SHAPES: readonly Shape[] = ["task", "panel"];

/** 路径占位符。四个，不多不少；未知占位符一律报错而不是静默放行。 */
export const PATH_VARS = ["{castdata}", "{workspace}", "{selected}", "{home}"] as const;
export type PathVar = (typeof PATH_VARS)[number];

export interface Example {
  /** 一次真实调用的入参。字段名必须与 args 一致。 */
  readonly call: Record<string, unknown>;
  /** 真实返回。裁到能让人看懂的最小形态即可，不要贴全量。 */
  readonly result: unknown;
  readonly note?: string;
}

export interface ToolDecl {
  readonly name: string;
  /** 一句话说明它解决什么问题，不描述实现。 */
  readonly purpose: string;
  /** 参数名 → 类型文字，如 { days: "number" }。保持极简，别写 JSON Schema。 */
  readonly args?: Record<string, string>;
  readonly returns?: string;
  /** 至少一条。强制项。 */
  readonly examples: Example[];
}

export interface ActionDecl {
  readonly name: string;
  readonly purpose: string;
  readonly args?: string[];
}

export interface Grants {
  readonly shell?: { readonly allow: readonly string[] };
  readonly net?: { readonly allow: readonly string[] };
  readonly store?: { readonly scope: "cast" | "workspace" };
  readonly file?: { readonly read?: readonly string[]; readonly write?: readonly string[] };
  readonly model?: { readonly allow?: readonly string[]; readonly maxTokens?: number };
  readonly agent?: { readonly allow: boolean; readonly maxTurns?: number };
}

export interface Budget {
  readonly observeBytes: number;
  readonly tools: number;
  readonly actions: number;
}

export interface CastManifest {
  readonly $schema?: string;
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly summary: string;
  /** 检索用的意图词。发现层靠它匹配任务，不靠读源码。 */
  readonly intents: readonly string[];
  readonly shape: Shape;
  readonly verbs: readonly Verb[];
  readonly entry: { readonly kind: "local" | "service"; readonly module: string };
  readonly tools: readonly ToolDecl[];
  readonly actions: readonly ActionDecl[];
  readonly grants: Grants;
  readonly budget: Budget;
}

/** 清单不写 budget 时用这套默认值；一键包「随手收」显式收到 2048 B。 */
export const DEFAULT_BUDGET: Budget = { observeBytes: 4096, tools: 24, actions: 32 };

const ID_RE = /^[a-z][a-z0-9-]{1,47}$/;
const TOOL_RE = /^[a-z][a-z0-9_]{1,47}$/;
const ACTION_RE = /^[a-z][a-z0-9-]{0,47}$/;
const CMD_RE = /^[a-z0-9][a-z0-9._-]*$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;

export interface ValidateOptions {
  /** 只用于报错定位，不参与校验。 */
  readonly file?: string;
}

export interface ValidateResult {
  readonly manifest: CastManifest | null;
  readonly issues: readonly Issue[];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function arr(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 校验清单。不抛异常，一次返回全部问题——让 agent 一轮就能改完，而不是修一个跑一次。
 * 这是与「遇到第一个错误就中止」相反的取舍，专门为批量修复优化。
 */
export function validateManifest(raw: unknown, options: ValidateOptions = {}): ValidateResult {
  const issues: Issue[] = [];
  const file = options.file;
  const at = (extra: Record<string, unknown> = {}) => ({ ...(file ? { file } : {}), ...extra });

  const root = obj(raw);
  if (!root) {
    issues.push(issue({ code: "KILN_MANIFEST_FIELD", message: "清单根必须是对象", detail: at({ field: "$" }) }));
    return { manifest: null, issues };
  }

  const add = (code: string, message: string, detail: Record<string, unknown>) =>
    issues.push(issue({ code, message, detail: at(detail) }));

  const id = str(root.id);
  if (!id) add("KILN_MANIFEST_FIELD", "缺少 id", { field: "id" });
  else if (!ID_RE.test(id)) add("KILN_MANIFEST_ID", `id 不合规: ${id}`, { field: "id", value: id });

  const version = str(root.version);
  if (!version) add("KILN_MANIFEST_FIELD", "缺少 version", { field: "version" });

  const title = str(root.title);
  if (!title) add("KILN_MANIFEST_FIELD", "缺少 title", { field: "title" });

  const summary = str(root.summary);
  if (!summary) add("KILN_MANIFEST_FIELD", "缺少 summary", { field: "summary" });

  const intentsRaw = arr(root.intents);
  const intents: string[] = [];
  if (!intentsRaw) add("KILN_MANIFEST_FIELD", "intents 必须是数组", { field: "intents" });
  else {
    for (const item of intentsRaw) {
      const s = str(item);
      if (s) intents.push(s);
      else add("KILN_MANIFEST_FIELD", "intents 的每一项必须是非空字符串", { field: "intents" });
    }
    if (intentsRaw.length === 0) add("KILN_MANIFEST_FIELD", "intents 不能为空", { field: "intents" });
  }

  const shapeRaw = str(root.shape);
  const shape: Shape = SHAPES.includes(shapeRaw as Shape) ? (shapeRaw as Shape) : "task";
  if (!SHAPES.includes(shapeRaw as Shape)) {
    add("KILN_MANIFEST_FIELD", "shape 只能是 task 或 panel", { field: "shape", value: shapeRaw });
  }

  const verbsRaw = arr(root.verbs);
  const verbs: Verb[] = [];
  if (!verbsRaw) add("KILN_MANIFEST_FIELD", "verbs 必须是数组", { field: "verbs" });
  else {
    for (const item of verbsRaw) {
      if (VERBS.includes(item as Verb)) verbs.push(item as Verb);
      else add("KILN_MANIFEST_FIELD", `verbs 出现未知动词: ${String(item)}`, { field: "verbs" });
    }
  }
  if (!verbs.includes("describe")) add("KILN_VERB_NO_DESCRIBE", "verbs 未包含 describe", { field: "verbs" });

  const entryRaw = obj(root.entry);
  const entryModule = entryRaw ? str(entryRaw.module) : null;
  const entryKind = entryRaw ? str(entryRaw.kind) : null;
  if (!entryModule) add("KILN_MANIFEST_FIELD", "缺少 entry.module", { field: "entry.module" });
  if (entryKind !== "local" && entryKind !== "service") {
    add("KILN_MANIFEST_FIELD", "entry.kind 只能是 local 或 service", { field: "entry.kind" });
  }

  const toolsRaw = arr(root.tools) ?? [];
  const tools: ToolDecl[] = [];
  if (root.tools !== undefined && !Array.isArray(root.tools)) {
    add("KILN_MANIFEST_FIELD", "tools 必须是数组", { field: "tools" });
  }
  const seenTools = new Set<string>();
  for (let i = 0; i < toolsRaw.length; i += 1) {
    const item = obj(toolsRaw[i]);
    const field = `tools[${i}]`;
    if (!item) {
      add("KILN_MANIFEST_FIELD", "工具项必须是对象", { field });
      continue;
    }
    const name = str(item.name);
    if (!name) add("KILN_MANIFEST_FIELD", "工具缺少 name", { field: `${field}.name` });
    else if (!TOOL_RE.test(name)) add("KILN_TOOL_NAME", `工具名不合规: ${name}`, { field: `${field}.name` });
    else if (seenTools.has(name)) add("KILN_TOOL_NAME", `工具名重复: ${name}`, { field: `${field}.name` });
    else seenTools.add(name);

    const purpose = str(item.purpose);
    if (!purpose) add("KILN_MANIFEST_FIELD", "工具缺少 purpose", { field: `${field}.purpose` });

    const examplesRaw = arr(item.examples);
    if (!examplesRaw || examplesRaw.length === 0) {
      add("KILN_TOOL_NO_EXAMPLE", `工具 ${name ?? field} 没有示例`, {
        field: `${field}.examples`,
        tool: name ?? field,
      });
    } else {
      for (let j = 0; j < examplesRaw.length; j += 1) {
        const ex = obj(examplesRaw[j]);
        if (!ex || obj(ex.call) === null || !("result" in ex)) {
          add("KILN_TOOL_NO_EXAMPLE", `工具 ${name ?? field} 的第 ${j + 1} 条示例不完整`, {
            field: `${field}.examples[${j}]`,
            tool: name ?? field,
          });
        }
      }
    }

    const argsRaw = obj(item.args);
    const args: Record<string, string> = {};
    if (argsRaw) {
      for (const [k, v] of Object.entries(argsRaw)) {
        const t = str(v);
        if (t) args[k] = t;
      }
    }

    const returns = str(item.returns);
    tools.push({
      name: name ?? field,
      purpose: purpose ?? "",
      ...(Object.keys(args).length > 0 ? { args } : {}),
      ...(returns ? { returns } : {}),
      examples: examplesRaw ? (examplesRaw as Example[]) : [],
    });
  }

  const actionsRaw = arr(root.actions) ?? [];
  const actions: ActionDecl[] = [];
  if (root.actions !== undefined && !Array.isArray(root.actions)) {
    add("KILN_MANIFEST_FIELD", "actions 必须是数组", { field: "actions" });
  }
  const seenActions = new Set<string>();
  for (let i = 0; i < actionsRaw.length; i += 1) {
    const item = obj(actionsRaw[i]);
    const field = `actions[${i}]`;
    if (!item) continue;
    const name = str(item.name);
    if (!name) add("KILN_MANIFEST_FIELD", "动作缺少 name", { field: `${field}.name` });
    else if (!ACTION_RE.test(name)) add("KILN_ACTION_NAME", `动作名不合规: ${name}`, { field: `${field}.name` });
    else if (seenActions.has(name)) add("KILN_ACTION_NAME", `动作名重复: ${name}`, { field: `${field}.name` });
    else seenActions.add(name);
    const purpose = str(item.purpose);
    if (!purpose) add("KILN_MANIFEST_FIELD", "动作缺少 purpose", { field: `${field}.purpose` });
    const argList = arr(item.args);
    actions.push({
      name: name ?? field,
      purpose: purpose ?? "",
      ...(argList ? { args: argList.filter((x): x is string => typeof x === "string") } : {}),
    });
  }

  const budgetRaw = obj(root.budget) ?? {};
  const budget: Budget = {
    observeBytes: typeof budgetRaw.observeBytes === "number" ? budgetRaw.observeBytes : DEFAULT_BUDGET.observeBytes,
    tools: typeof budgetRaw.tools === "number" ? budgetRaw.tools : DEFAULT_BUDGET.tools,
    actions: typeof budgetRaw.actions === "number" ? budgetRaw.actions : DEFAULT_BUDGET.actions,
  };

  if (tools.length > budget.tools) {
    add("KILN_BUDGET_EXCEEDED", `工具数 ${tools.length} 超过预算 ${budget.tools}`, {
      field: "budget.tools",
      actual: tools.length,
      budget: budget.tools,
    });
  }
  if (actions.length > budget.actions || actions.length > 32) {
    add("KILN_BUDGET_EXCEEDED", `动作数 ${actions.length} 超上限`, {
      field: "budget.actions",
      actual: actions.length,
      limit: Math.min(budget.actions, 32),
    });
  }

  // 动词与声明自洽
  if (verbs.includes("invoke") && tools.length === 0) {
    add("KILN_VERB_ORPHAN", "声明了 invoke 但没有任何工具", { field: "verbs" });
  }
  if (verbs.includes("act") && !verbs.includes("observe")) {
    add("KILN_VERB_PAIR", "声明了 act 但没有 observe", { field: "verbs" });
  }
  if (verbs.includes("act") && actions.length === 0) {
    add("KILN_VERB_ORPHAN", "声明了 act 但没有任何动作", { field: "verbs" });
  }
  if (shape === "task" && !verbs.includes("invoke")) {
    add("KILN_SHAPE_MISMATCH", "task 型必须有 invoke", { field: "shape" });
  }
  if (shape === "panel" && !(verbs.includes("observe") && verbs.includes("act"))) {
    add("KILN_SHAPE_MISMATCH", "panel 型必须同时有 observe 与 act", { field: "shape" });
  }

  // 授权声明
  const grantsRaw = obj(root.grants) ?? {};
  const grants: Record<string, unknown> = {};
  const KNOWN_GRANTS = new Set(["shell", "net", "store", "file", "model", "agent"]);
  for (const [key, value] of Object.entries(grantsRaw)) {
    if (!KNOWN_GRANTS.has(key)) {
      add("KILN_GRANT_UNKNOWN", `未知能力声明: ${key}`, { grant: key });
      continue;
    }
    grants[key] = value;
  }

  const shellRaw = obj(grantsRaw.shell);
  if (shellRaw) {
    const allow = arr(shellRaw.allow) ?? [];
    for (const cmd of allow) {
      const s = str(cmd);
      if (!s || !CMD_RE.test(s)) {
        add("KILN_GRANT_SHELL", `shell 白名单项不合规: ${String(cmd)}`, { value: String(cmd) });
      }
    }
  }

  const netRaw = obj(grantsRaw.net);
  if (netRaw) {
    const allow = arr(netRaw.allow) ?? [];
    for (const host of allow) {
      const s = str(host);
      if (!s || !HOST_RE.test(s)) {
        add("KILN_GRANT_NET", `net 白名单项不合规: ${String(host)}`, { value: String(host) });
      }
    }
  }

  const fileRaw = obj(grantsRaw.file);
  if (fileRaw) {
    for (const scope of ["read", "write"] as const) {
      const list = arr(fileRaw[scope]);
      if (!list) continue;
      for (const p of list) {
        const s = str(p);
        if (!s) continue;
        const used = PATH_VARS.filter((v) => s.includes(v));
        if (used.length === 0) {
          add("KILN_GRANT_PATHVAR", `路径缺少占位符: ${s}`, { field: `grants.file.${scope}`, value: s });
        } else if (!PATH_VARS.some((v) => s.startsWith(v))) {
          add("KILN_GRANT_PATHVAR", `占位符必须出现在路径开头: ${s}`, {
            field: `grants.file.${scope}`,
            value: s,
          });
        }
      }
    }
  }

  if (issues.length > 0) return { manifest: null, issues };

  return {
    manifest: {
      id: id as string,
      version: version as string,
      title: title as string,
      summary: summary as string,
      intents,
      shape,
      verbs,
      entry: { kind: entryKind as "local" | "service", module: entryModule as string },
      tools,
      actions,
      grants: grants as Grants,
      budget,
    },
    issues,
  };
}
