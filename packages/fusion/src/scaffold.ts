import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KilnError } from "#grain";

/**
 * cast 项目脚手架。
 *
 * `kiln new` 与 `kiln cast init` 共用这里：一次性写出「能通过 check、能连上 MCP、
 * 能被 agent 直接调用」的最小项目，而不是留一堆待填的 TODO。
 *
 * 生成的入口文件刻意不 import 任何模块：项目可以放在仓库外任意路径，
 * 不依赖 `#pact` 这类仓库内别名，也不会因为找不到 package.json 而加载失败。
 */

export type CastTemplate = "minimal" | "toolkit" | "panel";

export const CAST_TEMPLATES: readonly CastTemplate[] = ["minimal", "toolkit", "panel"];

export interface ScaffoldOptions {
  /** cast 根目录，cast.json 会写在这里。 */
  readonly dir: string;
  /** 项目根目录，README / .gitignore 写在这里；默认与 dir 相同。 */
  readonly projectRoot?: string;
  readonly id?: string;
  readonly title?: string;
  readonly template?: CastTemplate;
  readonly force?: boolean;
  /** 是否写 README 与 .gitignore，默认写。 */
  readonly docs?: boolean;
}

export interface ScaffoldResult {
  readonly root: string;
  readonly castDir: string;
  readonly template: CastTemplate;
  readonly files: readonly string[];
}

interface TemplateOutput {
  readonly manifest: Record<string, unknown>;
  readonly pact: string;
  readonly agents: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,47}$/;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** 只有生成在仓库内的 cast 才写 $schema；仓库外指向一个不存在的相对路径只会误导编辑器。 */
function schemaRef(castDir: string): string | null {
  const inside = !path.relative(REPO_ROOT, castDir).startsWith("..");
  if (!inside) return null;
  const rel = path.relative(castDir, path.join(REPO_ROOT, "docs", "schema", "cast-1.json"));
  return rel.split(path.sep).join("/");
}

/** 目录名 → 合法 cast id；不合法时回退，避免生成一个立刻校验失败的清单。 */
export function castIdFrom(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (ID_PATTERN.test(normalized)) return normalized;
  const trimmed = normalized.replace(/^-+/, "").slice(0, 47);
  if (ID_PATTERN.test(trimmed)) return trimmed;
  return "my-cast";
}

function baseManifest(
  id: string,
  title: string,
  summary: string,
  schema: string | null,
  intents: readonly string[],
): Record<string, unknown> {
  return {
    ...(schema === null ? {} : { $schema: schema }),
    id,
    version: "0.1.0",
    title,
    summary,
    intents: [...intents],
    shape: "task",
    verbs: ["describe", "invoke"],
    entry: { kind: "local", module: "./src/pact.ts" },
    tools: [],
    actions: [],
    grants: {},
    budget: { observeBytes: 2048, tools: 8, actions: 4 },
  };
}

function describeBlock(id: string, title: string, summary: string, shape: string, intents: string[]): string {
  return `  describe() {
    return {
      id: ${JSON.stringify(id)},
      version: "0.1.0",
      title: ${JSON.stringify(title)},
      summary: ${JSON.stringify(summary)},
      shape: ${JSON.stringify(shape)},
      intents: ${JSON.stringify(intents)},
    };
  },`;
}

function minimalTemplate(id: string, title: string, schema: string | null): TemplateOutput {
  const summary = "由 kiln new 生成的最小 cast：一个工具，一条真实示例";
  const intents = ["示例", "回显"];
  const manifest = baseManifest(id, title, summary, schema, intents);
  manifest.tools = [
    {
      name: "ping",
      purpose: "回显一段文本，用来确认工具链闭环",
      args: { text: "要回显的文本，可省略" },
      returns: "{ ok, tool, echo, at }",
      examples: [{ call: { text: "hello" }, result: { ok: true, tool: "ping", echo: "hello", at: 0 } }],
    },
  ];
  const pact = `/**
 * ${title}
 *
 * 只导出对象、不 import 任何模块：这份文件在仓库内外都能直接运行。
 * 需要类型提示时，在仓库内可加一行 \`import type { CastPact } from "#pact";\`
 * —— 类型导入在运行时会被完全擦除，不影响加载。
 *
 * 注意：cast 不能直接碰 fs / fetch / child_process。
 * 一切外部能力都要走 ctx.cap（shell / net / file / store），宿主才拦得住越界。
 */
export const pact = {
${describeBlock(id, title, summary, "task", intents)}
  async invoke(tool: string, args: Record<string, unknown>) {
    if (tool === "ping") {
      return { ok: true, tool, echo: args.text ?? null, at: Date.now() };
    }
    // 未实现的工具返回结构化说明，而不是抛异常：agent 能读懂并自行纠正。
    return { ok: false, reason: \`未实现工具: \${tool}\` };
  },
};
`;
  const agents = agentsDoc(title, id, [
    "`ping` 只有一个参数 `text`，可省略；省略时 echoed 为 null。",
    "本 cast 不需要任何授权（grants 为空），也不会访问网络或文件系统。",
  ]);
  return { manifest, pact, agents };
}

function toolkitTemplate(id: string, title: string, schema: string | null): TemplateOutput {
  const summary = "带持久化的小工具集：记住、取出、忘记";
  const intents = ["示例", "备忘", "键值"];
  const manifest = baseManifest(id, title, summary, schema, intents);
  manifest.grants = { store: { scope: "cast" } };
  manifest.budget = { observeBytes: 4096, tools: 16, actions: 8 };
  manifest.tools = [
    {
      name: "remember",
      purpose: "写入一条键值备忘",
      args: { key: "键名", value: "任意 JSON 值" },
      returns: "{ ok, key }",
      examples: [{ call: { key: "site", value: "example" }, result: { ok: true, key: "site" } }],
    },
    {
      name: "recall",
      purpose: "按 key 读取备忘，不存在时返回 found:false",
      args: { key: "键名" },
      returns: "{ ok, key, value, found }",
      examples: [{ call: { key: "site" }, result: { ok: true, key: "site", value: "example", found: true } }],
    },
    {
      name: "list_keys",
      purpose: "列出全部备忘键名",
      args: {},
      returns: "{ ok, keys }",
      examples: [{ call: {}, result: { ok: true, keys: ["site"] } }],
    },
  ];
  const pact = `/**
 * ${title}
 *
 * 这个模板演示了唯一正确的外部访问方式：ctx.cap.store。
 * 数据落在宿主指定的 cast 数据目录里，卸载 cast 时可以整目录删除。
 */
export const pact = {
${describeBlock(id, title, summary, "task", intents)}
  async invoke(tool: string, args: Record<string, unknown>, ctx: any) {
    const key = typeof args.key === "string" ? args.key : "";

    if (tool === "remember") {
      if (key === "") return { ok: false, reason: "缺少 key" };
      await ctx.cap.store.write(key, args.value ?? null);
      return { ok: true, key };
    }

    if (tool === "recall") {
      if (key === "") return { ok: false, reason: "缺少 key" };
      const value = await ctx.cap.store.read(key);
      return { ok: true, key, value: value ?? null, found: value !== undefined && value !== null };
    }

    if (tool === "list_keys") {
      return { ok: true, keys: await ctx.cap.store.keys() };
    }

    return { ok: false, reason: \`未实现工具: \${tool}\` };
  },
};
`;
  const agents = agentsDoc(title, id, [
    "三个工具都只需要字符串 `key`；`remember` 额外需要一个可序列化的 `value`。",
    "只申请了 `store` 权限（cast 作用域），没有 shell / net / file 权限。",
    "键名重复写入等价于覆盖，没有版本号。",
  ]);
  return { manifest, pact, agents };
}

function panelTemplate(id: string, title: string, schema: string | null): TemplateOutput {
  const summary = "面板型 cast：有状态、可观察、可操作";
  const intents = ["示例", "面板", "计数"];
  const manifest = baseManifest(id, title, summary, schema, intents);
  manifest.shape = "panel";
  manifest.verbs = ["describe", "observe", "act"];
  manifest.grants = { store: { scope: "cast" } };
  manifest.tools = [];
  manifest.actions = [
    { name: "bump", purpose: "把计数加一", args: ["by"] },
    { name: "reset", purpose: "把计数归零", args: [] },
  ];
  manifest.budget = { observeBytes: 2048, tools: 4, actions: 8 };
  const pact = `/**
 * ${title}
 *
 * panel 型 cast 用 observe + act 组成一个闭环：
 * 调用方先 observe 拿状态，再 act 改状态，act 的返回值里直接带最新 state，
 * 一次往返就能完成「读-改-读」，不需要再单独 observe 一遍。
 */
const COUNT_KEY = "count";

export const pact = {
${describeBlock(id, title, summary, "panel", intents)}
  async observe(ctx: any) {
    const raw = await ctx.cap.store.read(COUNT_KEY);
    const count = typeof raw === "number" ? raw : 0;
    return { at: Date.now(), fields: { count } };
  },

  async act(intent: any, ctx: any) {
    const raw = await ctx.cap.store.read(COUNT_KEY);
    let count = typeof raw === "number" ? raw : 0;

    if (intent.type === "bump") {
      const by = typeof intent.by === "number" ? intent.by : 1;
      count += by;
      await ctx.cap.store.write(COUNT_KEY, count);
      return { ok: true, note: \`+\${by}\`, state: { at: Date.now(), fields: { count } } };
    }

    if (intent.type === "reset") {
      count = 0;
      await ctx.cap.store.write(COUNT_KEY, count);
      return { ok: true, note: "已归零", state: { at: Date.now(), fields: { count } } };
    }

    // 未知意图必须显式失败，而不是静默忽略。
    return { ok: false, note: \`未知意图: \${intent.type}\` };
  },
};
`;
  const agents = agentsDoc(title, id, [
    "先 `observe` 读 state，再 `act` 改状态；`act` 返回的 `state` 已是最新值。",
    "已知意图：`bump`（可选 `by`，默认 1）、`reset`。未知意图返回 ok:false。",
    "只申请了 `store` 权限，状态持久化在 cast 数据目录。",
  ]);
  return { manifest, pact, agents };
}

function agentsDoc(title: string, id: string, rules: readonly string[]): string {
  return [
    `# ${title}`,
    "",
    `这是 cast \`${id}\` 的接入说明，给人看，也给 agent 看。`,
    "",
    "## 怎么调",
    "",
    "支持 MCP 的客户端：执行 `kiln mcp <本目录>`，工具名形如 `<id>__invoke__<tool>`。",
    "只能发 HTTP 的客户端：执行 `kiln serve <本目录>`，用 `/tools/list` 与 `/tools/call`。",
    "只想先看契约：`kiln agents <本目录> --format openai|mcp|plain`。",
    "",
    "## 调用须知",
    "",
    ...rules.map((line) => `- ${line}`),
    "",
    "## 失败怎么处理",
    "",
    "工具失败时返回 `ok: false` 并附 `reason`，不抛异常。看到 `ok:false` 应该调整参数或换工具，",
    "而不是原样重试；连续两次同样失败说明契约理解错了，回去读一遍 `cast.json`。",
    "",
  ].join("\n");
}

export async function scaffoldCastProject(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const castDir = path.resolve(options.dir);
  const projectRoot = path.resolve(options.projectRoot ?? options.dir);
  const withDocs = options.docs !== false;
  const template = options.template ?? "minimal";
  if (!CAST_TEMPLATES.includes(template)) {
    throw new KilnError({
      code: "KILN_USAGE",
      message: `未知模板: ${template}`,
      hint: `可选：${CAST_TEMPLATES.join(" / ")}`,
    });
  }

  if (!options.force) {
    try {
      await access(path.join(castDir, "cast.json"));
      throw new KilnError({
        code: "KILN_USAGE",
        message: `目标位置已存在 cast：${castDir}`,
        hint: "换一个目录，或加 --force 覆盖（会重写 cast.json 与 src/pact.ts）。",
      });
    } catch (error) {
      if (error instanceof KilnError) throw error;
    }
  }

  const id = options.id ?? castIdFrom(path.basename(projectRoot) || "cast");
  const title = options.title ?? id;
  const schema = schemaRef(castDir);
  const built =
    template === "toolkit"
      ? toolkitTemplate(id, title, schema)
      : template === "panel"
        ? panelTemplate(id, title, schema)
        : minimalTemplate(id, title, schema);

  await mkdir(path.join(castDir, "src"), { recursive: true });
  const files = [
    path.join(castDir, "cast.json"),
    path.join(castDir, "src", "pact.ts"),
    path.join(castDir, "AGENTS.md"),
    path.join(castDir, ".mcp.json"),
  ];
  if (withDocs) {
    files.push(
      path.join(projectRoot, "package.json"),
      path.join(projectRoot, "README.md"),
      path.join(projectRoot, ".gitignore"),
    );
  }

  const nested = path.relative(projectRoot, castDir).split(path.sep).filter(Boolean).join("/");
  const mcpTarget = nested === "" ? "${workspaceFolder}" : `\${workspaceFolder}/${nested}`;
  const mcp = {
    mcpServers: { [id]: { command: "kiln", args: ["mcp", mcpTarget] } },
  };
  const readme = `# ${title}

由 \`kiln new\` 生成的 Kiln cast（模板：${template}）。

## 跑起来

\`\`\`bash
kiln check .        # 校验清单与实现是否对得上
kiln describe .     # 看它对外暴露了什么
kiln mcp .          # 以 MCP stdio 服务接入任意支持 MCP 的 agent
kiln serve . --port 4312
                    # 起一个 HTTP 网关，任何语言都能调
\`\`\`

还没装 \`kiln\` 命令时，用仓库里的入口：\`node <kiln 仓库>/packages/surface/src/cli.ts check .\`。

## 改哪里

| 文件 | 作用 |
| --- | --- |
| \`cast.json\` | 契约：工具、参数、真实示例、需要的授权 |
| \`src/pact.ts\` | 实现：四个动词的具体行为 |
| \`AGENTS.md\` | 给人和 agent 看的接入说明 |

改完 \`cast.json\` 记得同步 \`pact.ts\`——两边对不上时 \`kiln check\` 会直接报出来。
`;
  const gitignore = `node_modules/
.kiln/
*.log
`;

  await writeFile(files[0]!, `${JSON.stringify(built.manifest, null, 2)}\n`, "utf8");
  await writeFile(files[1]!, built.pact, "utf8");
  await writeFile(files[2]!, built.agents, "utf8");
  await writeFile(files[3]!, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
  if (withDocs) {
    await writeFile(
      files[4]!,
      `${JSON.stringify({ name: id, version: "0.1.0", private: true, type: "module" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(files[5]!, readme, "utf8");
    await writeFile(files[6]!, gitignore, "utf8");
  }

  return { root: projectRoot, castDir, template, files };
}
