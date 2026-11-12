# 错误码索引

所有结构化错误的 `docs` 字段都指向本文的对应小节，路径相对仓库根目录，例如 `docs/ERRORS.md#kiln_one_integrity`。这样错误说明随源码一起分发，不依赖外部站点。

错误对象形状统一为 `{ code, message, hint, docs, detail? }`：

| 字段      | 含义                                               |
| --------- | -------------------------------------------------- |
| `code`    | 稳定错误码，是公开契约的一部分：新增可以，改名不行 |
| `message` | 一句话说明发生了什么                               |
| `hint`    | 一句可执行的修复建议，agent 可直接照做             |
| `docs`    | 指向本文对应小节的相对地址                         |
| `detail`  | 可选的上下文（字段名、实际值、原因等）             |

登记表现共 **54** 个错误码，定义见 `packages/grain/src/codes.ts`。CLI 退出码：`0` 成功、`1` 有问题、`2` 用法错误。

## 清单与契约

### KILN_MANIFEST_UNREADABLE

清单读取失败。确认 `cast.json` 存在于目录根部且是合法 JSON；可单独用 `node -e "JSON.parse(require('fs').readFileSync('cast.json'))"` 验证。

### KILN_MANIFEST_FIELD

清单字段缺失或类型不对。按 `docs/PACT.md` 的清单表补齐；`detail.field` 指明具体字段路径。

### KILN_MANIFEST_ID

cast id 不合规。id 只能是小写字母开头、由小写字母/数字/短横线组成，长度 2–48。

### KILN_SHAPE_MISMATCH

`shape` 与 `verbs` 不自洽。`task` 必须提供 `invoke`；`panel` 必须同时提供 `observe` 与 `act`。

### KILN_VERB_NO_DESCRIBE

缺少 `describe`。没有描述，任何 agent 都无法判断该不该调用这个 cast。

### KILN_VERB_ORPHAN

动词没有对应的声明。声明了 `invoke` 就要在 `tools` 里列出至少一个工具；声明了 `act` 就要在 `actions` 里列出动作。

### KILN_VERB_PAIR

`act` 缺少 `observe`。动作会改变状态，必须能读回状态，否则 agent 无法确认动作是否生效。

### KILN_TOOL_NAME

工具名不合规。只能是小写字母开头、由小写字母/数字/下划线组成，长度 2–48，同一 cast 内不得重名。

### KILN_TOOL_NO_EXAMPLE

工具缺少示例调用。每个工具至少要有一条真实的 `call` + `result` 示例；示例是 agent 学一个工具最省 token 的方式。

### KILN_ACTION_NAME

动作名不合规。只能是小写字母开头、由小写字母/数字/短横线组成，长度 1–48，最多 32 个。

### KILN_BUDGET_EXCEEDED

超出声明的预算。工具/动作数量或 `observe` 体积超过 `budget`；精简声明，或上调预算并说明理由。

### KILN_GRANT_UNKNOWN

声明了未知的能力。`grants` 只接受 `shell` / `net` / `store` / `file` / `model` / `agent` 六类。

### KILN_GRANT_PATHVAR

路径变量不认识。路径里只能用 `{castdata}` / `{workspace}` / `{selected}` / `{home}`，且占位符必须出现在开头。

### KILN_GRANT_SHELL

`shell` 白名单写法不对。每条只能是一个命令名（如 `git`），不能带参数、空格或管道；参数写在代码里。

### KILN_GRANT_NET

`net` 白名单写法不对。每条只能是一个主机名（可带端口），不能带协议、路径或通配符。

### KILN_ENTRY_MISSING

入口模块不存在。`entry.module` 是相对 cast 目录的路径，检查是否误写成相对仓库根的路径。

### KILN_ENTRY_EXPORT

入口没有导出 `pact`。入口模块必须导出名为 `pact` 的对象或工厂函数，签名见 `docs/PACT.md`。

### KILN_PACT_MISMATCH

声明与实现不一致。清单里的 `tools` / `actions` 必须与 `pact` 实现一一对应，`detail` 列出多出与缺少的项。

### KILN_PACT_MISSING_VERB

动词未实现。`verbs` 里声明了某个动词，`pact` 上却没有对应方法；实现它，或从 `verbs` 里删掉。

## 能力授权与运行时

### KILN_CAP_DENIED

能力被宿主拒绝。检查 `cast.json` 的 `grants` 与宿主策略，`detail.reason` 给出拒绝依据。越权拒绝不可被业务代码吞掉。

### KILN_CAP_ASK

能力需要人工确认。宿主策略为 `ask` 但当前是非交互环境；预先授权该能力，或改用只读方案。

### KILN_CALL_TIMEOUT

调用超时。把长任务拆成多次 `invoke`，或用 `act` 推进一个已存在的状态机。

### KILN_CALL_FAILED

调用内部失败。看 `detail.cause`；cast 作者应把可预期的失败转成结构化结果，而不是抛异常。

## 插件与适配器

### KILN_PLUGIN_DUPLICATE

插件标识重复。同一宿主内插件 `name` 必须唯一，`detail.name` 给出冲突的名字。

### KILN_PLUGIN_FAILED

插件装载失败。看 `detail.cause`；插件失败不会拖垮宿主，但它的贡献不会生效。

### KILN_ADAPTER_UNKNOWN

未知的 agent 适配器。用 `kiln plugins --json` 查看当前宿主注册了哪些适配器。

## 命令与界面

### KILN_USAGE

命令用法错误。运行 `kiln --help` 查看用法；退出码 `2` 专门表示用法错误。

### KILN_PROJECT_NOT_FOUND

找不到请求的 cast 或路由。确认 Studio 根目录下存在该 `cast.json`，或检查请求路径是否拼写正确。

## 一键包（产品层）

### KILN_ONE_BUNDLE

一键包配置或应用目录有问题。检查 `up.json` 与 `apps/` 下的 `cast.json`，修正后运行 `kiln seal <bundle>`。

### KILN_ONE_INTEGRITY

一键包完整性校验失败。确认改动来自你自己后重新 `kiln seal`；否则换回原始一键包，不要运行未审阅的代码。

### KILN_ONE_APPROVAL

一键包尚未授权或授权已撤销。运行 `kiln permissions <bundle> --action grant`，或在状态面板点「重新授权」。

### KILN_ONE_CLIENT

agent 客户端配置读写失败。客户端配置必须是合法 JSON 且 `mcpServers` 是对象；Kiln 不会覆盖损坏的用户配置。

### KILN_ONE_HANDSHAKE

agent 连接自检未通过。用 `kiln check` 查契约，或 `kiln mcp <apps> --policy strict` 手动复现，修复后重跑 `kiln up`。

### KILN_ONE_RUNTIME

kiln 运行时不可用。需要 Node ≥22.18；设置 `KILN_HOME` 指向仓库根目录，或把一键包放在仓库内。

### KILN_ONE_STATE

连接状态文件损坏。备份后删除 `.kiln/state/one-state.json`，再运行 `kiln up <bundle>` 重建。

### KILN_ONE_AUTOSTART

开机自启项写入失败。检查目录权限，或用 `KILN_ONE_AUTOSTART_DIR` 指定可写目录；`kiln down` 可随时移除。

### KILN_ONE_USAGE

一键包命令或面板请求参数错误。用 `kiln --help` 查看命令用法；面板接口只接受 JSON 对象与受支持的 `action`。

## 融合层（artifact / 宿主 / 远程调用）

### KILN_FUSION_ARTIFACT

版本化 artifact 有问题（结构、哈希、文件缺失或清单未通过校验）。先 `kiln check <dir>` 修复清单，再 `kiln artifact build` 重新构建；拒绝导入被篡改的包。

### KILN_FUSION_SIGNATURE

签名校验失败。用 `kiln keygen` 生成密钥，确认 `--key-dir` 指向同一目录；签名不匹配时不要安装。

### KILN_FUSION_APPROVAL

宿主应用尚未获批或审批已撤销。运行 `kiln host approve <id>`；撤销后必须重新审批。

### KILN_FUSION_ISOLATED

子进程隔离执行失败。确认 cast 可独立运行、Node ≥22.18，必要时增大超时；宿主进程不受影响。

### KILN_FUSION_CAST

Kiln 原生 cast 脚手架调用失败。先 `kiln cast init <项目目录>` 生成原生 cast，再用 `kiln cast check <项目目录>` 校验；脚手架不依赖任何外部框架。

### KILN_FUSION_HOST

宿主生命周期操作失败。用 `kiln host list` 查看已安装应用与状态，确认 id、`--verb` 与目录正确。

### KILN_FUSION_DISCOVERY

发现层检索失败。确认 `--dir` 指向含 `cast.json` 的目录，且清单填写了 `intents`。

### KILN_FUSION_HTTP

HTTP / SSE MCP 请求失败。确认请求发往 `/mcp` 或 `/sse`、令牌正确、工具名已在 `tools/list` 中声明。

### KILN_SANDBOX_TIMEOUT

隔离执行超时。把长任务拆成多次 invoke，或增大 `--timeout`；死循环会被强制终止，宿主不受影响。

### KILN_SANDBOX_MEMORY

隔离执行超出内存上限。减少单次处理的数据量，或增大 `--memory`；超限线程会被整体终止。

### KILN_SANDBOX_CRASH

隔离线程崩溃。检查 `pact.ts` 是否在模块加载阶段抛错或调用 `process.exit`，先用 `kiln check` 静态校验。

### KILN_PACK_INVALID

`.kiln` 安装包不合法。用 `kiln artifact build --out app.kiln` 重新打包，并用 `kiln artifact verify` 校验签名与哈希。

### KILN_PACK_INSTALL

安装应用失败。确认安装源可访问、包未超过 32 MB；需要签名时用 `--key-dir` 指定公钥目录。

## Agent 接入与模型

### KILN_AGENT_HTTP

通用 HTTP 网关请求失败。确认请求发往 `/health`、`/describe`、`/tools/list` 或 `/tools/call`，body 是 JSON 对象，且 Bearer token 正确。

### KILN_CODING_AGENT

内置 coding agent 未启用或配置不全。在 `cast.json` 的 `grants` 里加 `{ "agent": { "allow": true } }`，并用 `--base-url` 与 `--model` 指定 OpenAI 兼容端点。

### KILN_ENGINE_MISSING

指定的 coding agent 引擎不可用。用 `--engine builtin` 走零依赖的内置引擎；要用 Pi 引擎先执行 `npm i -D @earendil-works/pi-agent-core`。`kiln doctor` 会报告当前可用的引擎。

### KILN_MODEL_FAILED

模型端点调用失败。确认 `baseUrl` 指向 OpenAI 兼容的 `/v1` 根路径、模型名存在、密钥有效；`detail` 里有状态码与响应片段。

## 相关文档

- 融合层功能与命令：[FUSION.md](./FUSION.md)
- 契约与清单字段：[PACT.md](./PACT.md)
- 一键包接口与配置：[ONE-API.md](./ONE-API.md)
- 部署与故障排查：[ONE-OPS.md](./ONE-OPS.md)
- 插件扩展点：[PLUGINS.md](./PLUGINS.md)
