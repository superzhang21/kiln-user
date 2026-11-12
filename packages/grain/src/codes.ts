// 错误码是公开契约的一部分：新增可以，改名不行。
// 每个码自带一句可执行的修复建议，避免调用方（尤其是 agent）靠猜。

export interface CodeSpec {
  readonly title: string;
  readonly hint: string;
}

export const CODES = {
  KILN_MANIFEST_UNREADABLE: {
    title: "清单读取失败",
    hint: "确认 cast.json 存在于目录根部，且是合法 JSON（可用 node -e \"JSON.parse(require('fs').readFileSync('cast.json'))\" 单独验证）。",
  },
  KILN_MANIFEST_FIELD: {
    title: "清单字段缺失或类型不对",
    hint: "按 docs/PACT.md 的清单表补齐该字段；detail.field 指明了具体字段路径。",
  },
  KILN_MANIFEST_ID: {
    title: "cast id 不合规",
    hint: "id 只能是小写字母开头、由小写字母/数字/短横线组成，长度 2–48。",
  },
  KILN_SHAPE_MISMATCH: {
    title: "shape 与 verbs 不自洽",
    hint: "shape=task 必须提供 invoke；shape=panel 必须同时提供 observe 与 act。",
  },
  KILN_VERB_NO_DESCRIBE: {
    title: "缺少 describe",
    hint: "verbs 必须包含 describe：没有描述，任何 agent 都无法判断该不该调用。",
  },
  KILN_VERB_ORPHAN: {
    title: "动词没有对应的声明",
    hint: "声明了 invoke 就必须在 tools 里列出至少一个工具；声明了 act 就必须在 actions 里列出动作。",
  },
  KILN_VERB_PAIR: {
    title: "act 缺少 observe",
    hint: "act 会改变状态，必须配 observe，否则 agent 无法确认动作是否生效。",
  },
  KILN_TOOL_NAME: {
    title: "工具名不合规",
    hint: "工具名只能是小写字母开头、由小写字母/数字/下划线组成，长度 2–48，同一 cast 内不得重名。",
  },
  KILN_TOOL_NO_EXAMPLE: {
    title: "工具缺少示例调用",
    hint: "每个工具至少要有一条真实示例（call 与 result 都要有）。示例是 agent 学一个工具最省 token 的方式，不接受省略。",
  },
  KILN_ACTION_NAME: {
    title: "动作名不合规",
    hint: "动作名只能是小写字母开头、由小写字母/数字/短横线组成，长度 1–48，最多 32 个。",
  },
  KILN_BUDGET_EXCEEDED: {
    title: "超出声明的预算",
    hint: "tools/actions 数量或 observe 体积超过 budget；要么精简声明，要么上调 budget 并说明理由。",
  },
  KILN_GRANT_UNKNOWN: {
    title: "声明了未知的能力",
    hint: "grants 只接受 shell / net / store / file / model / agent 六类；detail.grant 给出了实际写的是什么。",
  },
  KILN_GRANT_PATHVAR: {
    title: "路径变量不认识",
    hint: "路径里只能用 {castdata} / {workspace} / {selected} / {home} 四个占位符，且必须整体出现在路径开头。",
  },
  KILN_GRANT_SHELL: {
    title: "shell 白名单写法不对",
    hint: "每条只能是一个命令名（如 git），不能带参数、空格或管道；参数请写在代码里。",
  },
  KILN_GRANT_NET: {
    title: "net 白名单写法不对",
    hint: "每条只能是一个主机名，可带端口（如 api.example.com:443），不能带协议、路径或通配符。",
  },
  KILN_ENTRY_MISSING: {
    title: "入口模块不存在",
    hint: "entry.module 是相对 cast 目录的路径，且必须真实存在；检查是否写成了相对仓库根的路径。",
  },
  KILN_ENTRY_EXPORT: {
    title: "入口没有导出 pact",
    hint: "入口模块必须 export 一个名为 pact 的对象或工厂函数，签名见 docs/PACT.md。",
  },
  KILN_PACT_MISMATCH: {
    title: "声明与实现不一致",
    hint: "清单里的 tools/actions 必须与 pact 实际实现的方法一一对应；detail 列出多出与缺少的项。",
  },
  KILN_PACT_MISSING_VERB: {
    title: "动词未实现",
    hint: "verbs 里声明了某个动词，pact 上却没有对应方法；要么实现，要么从 verbs 里删掉。",
  },
  KILN_CAP_DENIED: {
    title: "能力被宿主拒绝",
    hint: "该能力未获授权。检查 cast.json 的 grants 与宿主策略；detail.reason 给出了拒绝依据。",
  },
  KILN_CAP_ASK: {
    title: "能力需要人工确认",
    hint: "宿主策略为 ask，但当前是非交互环境。预先授权该能力，或改用只读方案。",
  },
  KILN_CALL_TIMEOUT: {
    title: "调用超时",
    hint: "单次调用有时间上限；把长任务拆成多次 invoke，或用 act 推进一个已存在的状态机。",
  },
  KILN_CALL_FAILED: {
    title: "调用内部失败",
    hint: "看 detail.cause。cast 作者应把可预期的失败转成结构化结果，而不是抛异常。",
  },
  KILN_PLUGIN_DUPLICATE: {
    title: "插件标识重复",
    hint: "同一宿主内插件 name 必须唯一；detail.name 给出了冲突的名字。",
  },
  KILN_PLUGIN_FAILED: {
    title: "插件装载失败",
    hint: "看 detail.cause。插件失败不会拖垮宿主，但它的贡献不会生效。",
  },
  KILN_ADAPTER_UNKNOWN: {
    title: "未知的 agent 适配器",
    hint: "用 kiln plugins --json 查看当前宿主注册了哪些适配器。",
  },
  KILN_USAGE: {
    title: "命令用法错误",
    hint: "kiln --help 查看用法；退出码 2 专门表示用法错误。",
  },
  KILN_ONE_BUNDLE: {
    title: "一键包配置或应用目录有问题",
    hint: "检查 up.json 与 apps/ 下的 cast.json；修正后运行 kiln seal <bundle> 重新生成完整性清单。",
  },
  KILN_ONE_INTEGRITY: {
    title: "一键包完整性校验失败",
    hint: "确认改动来自你自己后运行 kiln seal <bundle>；否则换回原始一键包。不要运行未审阅的代码。",
  },
  KILN_ONE_APPROVAL: {
    title: "一键包尚未授权或授权已撤销",
    hint: "运行 kiln permissions <bundle> --action grant 完成一次授权，或在状态面板点「重新授权」。",
  },
  KILN_ONE_CLIENT: {
    title: "agent 客户端配置读写失败",
    hint: "客户端配置必须是合法 JSON 且 mcpServers 是对象；修复后重跑 kiln up。Kiln 不会覆盖损坏的用户配置。",
  },
  KILN_ONE_HANDSHAKE: {
    title: "agent 连接自检未通过",
    hint: "用 kiln check <bundle>/apps/<cast> 查契约，或 kiln mcp <bundle>/apps --policy strict 手动复现；修复后重跑 kiln up。",
  },
  KILN_ONE_RUNTIME: {
    title: "kiln 运行时不可用",
    hint: "需要 Node >=22.18；设置 KILN_HOME 指向 kiln 仓库根目录，或把一键包放在仓库内。",
  },
  KILN_ONE_STATE: {
    title: "连接状态文件损坏",
    hint: "备份后删除 .kiln/state/one-state.json，再运行 kiln up <bundle> 重建。",
  },
  KILN_ONE_AUTOSTART: {
    title: "开机自启项写入失败",
    hint: "检查目录权限，或用 KILN_ONE_AUTOSTART_DIR 指定可写目录；kiln down 可随时移除自启项。",
  },
  KILN_ONE_USAGE: {
    title: "一键包命令或面板请求参数错误",
    hint: "用 kiln --help 查看命令用法；面板接口只接受 JSON 对象与受支持的 action。",
  },
  KILN_PROJECT_NOT_FOUND: {
    title: "找不到请求的 cast 或路由",
    hint: "确认 Studio 根目录下存在该 cast.json，或检查请求路径是否拼写正确。",
  },
  KILN_FUSION_ARTIFACT: {
    title: "版本化 artifact 有问题",
    hint: "先运行 kiln check <dir> 修复清单，再用 kiln artifact build 重新构建；拒绝导入被篡改的包。",
  },
  KILN_FUSION_SIGNATURE: {
    title: "artifact 签名校验失败",
    hint: "用 kiln keygen 生成密钥并确认 --key-dir 指向同一目录；签名不匹配时不要安装。",
  },
  KILN_FUSION_APPROVAL: {
    title: "宿主应用尚未获批",
    hint: "运行 kiln host approve <id> 完成审批；撤销后必须重新审批才能调用。",
  },
  KILN_FUSION_ISOLATED: {
    title: "子进程隔离执行失败",
    hint: "确认 cast 可独立运行、Node 版本 ≥22.18，必要时增大超时；宿主进程不受影响。",
  },
  KILN_FUSION_CAST: {
    title: "Kiln 原生 cast 脚手架调用失败",
    hint: "先运行 kiln cast init <项目目录> 生成原生 cast，再用 kiln cast check <项目目录> 校验；脚手架不依赖任何外部框架。",
  },
  KILN_FUSION_HOST: {
    title: "宿主生命周期操作失败",
    hint: "用 kiln host list 查看已安装应用与状态，确认 id、verb 与应用目录正确。",
  },
  KILN_FUSION_DISCOVERY: {
    title: "发现层检索失败",
    hint: "确认 --dir 指向含 cast.json 的目录，且清单里填写了 intents 字段。",
  },
  KILN_FUSION_HTTP: {
    title: "HTTP / SSE MCP 请求失败",
    hint: "确认请求发往 /mcp 或 /sse、令牌正确、工具名已在 tools/list 中声明。",
  },
  KILN_SANDBOX_TIMEOUT: {
    title: "隔离执行超时",
    hint: "把长任务拆成多次 invoke，或增大 --timeout；死循环会被强制终止，宿主不受影响。",
  },
  KILN_SANDBOX_MEMORY: {
    title: "隔离执行超出内存上限",
    hint: "减少单次处理的数据量，或增大 --memory；内存超限的线程会被整体终止。",
  },
  KILN_SANDBOX_CRASH: {
    title: "隔离线程崩溃",
    hint: "检查 pact.ts 是否在模块加载阶段抛错或调用 process.exit；用 kiln check 先做静态校验。",
  },
  KILN_PACK_INVALID: {
    title: ".kiln 安装包不合法",
    hint: "用 kiln artifact build --out app.kiln 重新打包，并用 kiln artifact verify 校验签名与哈希。",
  },
  KILN_PACK_INSTALL: {
    title: "安装应用失败",
    hint: "确认安装源可访问、包未超过 32 MB；需要签名时用 --key-dir 指定公钥目录。",
  },
  KILN_AGENT_HTTP: {
    title: "通用 HTTP 网关请求失败",
    hint: "确认请求发往 /health、/describe、/tools/list 或 /tools/call，body 是 JSON 对象，且 Bearer token 正确。",
  },
  KILN_CODING_AGENT: {
    title: "内置 coding agent 未启用或配置不全",
    hint: '在 cast.json 的 grants 里加 { "agent": { "allow": true } }，并用 --base-url 与 --model 指定 OpenAI 兼容端点。',
  },
  KILN_ENGINE_MISSING: {
    title: "指定的引擎不可用",
    hint: "用 --engine builtin 走零依赖的内置引擎；要用 Pi 引擎先执行 npm i -D @earendil-works/pi-agent-core。",
  },
  KILN_MODEL_FAILED: {
    title: "模型端点调用失败",
    hint: "确认 baseUrl 指向 OpenAI 兼容的 /v1 根路径、model 名称存在、apiKey 有效；detail 里有状态码与响应片段。",
  },
} as const satisfies Record<string, CodeSpec>;

export type Code = keyof typeof CODES;

export function specFor(code: string): CodeSpec {
  return (
    (CODES as Record<string, CodeSpec>)[code] ?? {
      title: "未登记的错误",
      hint: "这是框架自身的问题，请带上 code 提 issue。",
    }
  );
}
