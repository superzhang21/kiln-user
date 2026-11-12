# 变更记录

格式参照 [Keep a Changelog 1.1.0 中文版](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。小标题按本仓库约定使用简体中文。

## [未发布]

### 上手与网关加固

- 新增 `kiln new <dir>`：生成可直接通过 `check` 的 cast 项目（`cast.json` + `src/pact.ts` + `AGENTS.md` + `.mcp.json` + `package.json` + `README.md` + `.gitignore`）。三套模板：`minimal` / `toolkit`（带持久化）/ `panel`（observe + act），支持 `--name` / `--title` / `--force`。
- 新增 `packages/fusion/src/scaffold.ts`：`kiln new` 与 `kiln cast init` 共用同一套生成逻辑；`cast init` 行为与历史默认值（id `cast`、`<项目>/kiln/` 布局）保持兼容。
- `checkCast` 同时接受两种布局：`cast.json` 在目录根部，或在 `<目录>/kiln/` 下。少一种兼容，用户就会在「明明检查过了」的地方卡住。
- HTTP 网关加固：固定窗口限流（`--rate-limit`，默认 120 次/分钟）、并发上限（`--concurrency`，默认 4，超出立刻拒绝不排队）、单次调用超时（`--timeout`，默认 120 秒）。超限返回 `429` + `retry-after` 与 `x-ratelimit-*` 响应头，超时返回 `504`，全部是结构化 `error`。
- `kiln serve --detach` / `--stop`：脱离终端后台运行，pid 与日志落在 `<workspace>/.kiln/serve/`；同一目录重复 detach 会被拒绝，避免起两份抢端口。
- 新增 `packages/platform/src/daemon.ts`：状态文件稳定映射、存活探测（含 `EPERM` 判定）、`SIGTERM → 轮询 → SIGKILL` 的优雅停止、脱离终端启动。
- `kiln doctor` 与 `--help` 重排：新增「上手」段，`serve` 的限额与后台参数写进帮助。
- 新增测试：`scaffold`（5 项）+ `daemon`（4 项）+ HTTP 网关扩到 5 项，测试总数 113 → 126。
- 文档：新增 `QUICKSTART.md`（15 分钟跑通），重写 `README.md` 上手路径，更新 `AGENTS.md` / `PLATFORM.md` / `ARCHITECTURE.md` / `STANDALONE.md` / `TESTING.md`；`docs/images/` 补齐 6 张真实运行截图并做脱敏。

### 可换引擎的 coding agent

- 把 `packages/coding-agent` 拆成「引擎 + 工具面」：引擎只决定下一步调什么工具，工具永远来自 `AgentBridge`（能力网关 + 审计）。
- 新增 `pi` 引擎：以可选 peer 依赖方式接入 `@earendil-works/pi-agent-core` 的 `Agent` 运行时，工具表整体替换为 cast 的工具；**不使用** Pi 自带的 `read` / `bash` / `edit` / `write`，避免引擎绕过授权直接操作宿主机。
- Pi 的 provider 由 Kiln 自己组装（`api/openai-completions` + 一个指向 `--base-url` 的 provider），不读取 Pi 的用户配置，也不额外连别的端点。
- CLI 新增 `--engine auto|builtin|pi`；`auto` 探测不到 Pi 时回落到内置引擎，显式指定 `pi` 但不可用时抛 `KILN_ENGINE_MISSING`（不静默回落）。
- `kiln doctor` 增加引擎可用性报告；新增 `KILN_DEBUG=1` 诊断日志。
- 修正 Pi 引擎的错误上报：模型 `stopReason=error` 时抛 `KILN_MODEL_FAILED`，不再返回看似成功的结果。
- 新增 `test/pi-engine.spec.ts`（5 项，含「Pi 拿不到自带工具」与「不静默成功」的断言），测试总数 108 → 113；新增错误码 `KILN_ENGINE_MISSING`（总数 54）。

### 独立化与任意 agent 接入

- 新增 `packages/platform`：跨平台运行时探测（OS / 架构 / Node / Shell / 家目录 / 路径归一化），新增 `kiln doctor`。
- 新增 `packages/agents`：进程内 `AgentBridge` + `mcp | openai | plain` 三种描述投影；新增 `kiln agents`。
- 新增通用 HTTP 网关 `packages/agents/http.ts` 与 `kiln serve`（`/health`、`/describe`、`/tools/list`、`/tools/call`，Bearer 鉴权，业务失败返回结构化 `error`）。
- 新增可选内置 coding agent `packages/coding-agent` 与 `kiln code`（OpenAI 兼容端点、`chat` 可注入、轮次有界、默认关闭并受 `grants.agent.allow` 约束）。
- 新增错误码 `KILN_AGENT_HTTP` / `KILN_CODING_AGENT` / `KILN_MODEL_FAILED`（总数 53）。
- 新增 12 个测试（总数 108）与 4 份文档：`STANDALONE.md` / `AGENTS.md` / `CODING-AGENT.md` / `PLATFORM.md`。

### 新增

- **Kiln One 产品层**（`packages/one`）：自描述一键包、启动编排、授权状态、客户端自动注册、握手自检、开机自启、本机状态面板。
- **一键包 `one/`**：`AGENT.md`（给 agent 读）、`up.json`、`kiln-up.mjs/.cmd/.sh`、`checksums.json`，开箱自带应用「随手收」（`one/apps/catchall`）。
- CLI：`kiln up` / `down` / `status` / `seal` / `permissions` / `panel`；`kiln-one` 入口指向 `one/kiln-up.mjs`。
- 默认策略 `strict`、可读权限清单、一次授权与显式撤销；sha256 完整性 seal / verify（篡改、缺失、未登记文件一次报全部）。
- agent 客户端 MCP stdio 配置自动探测、幂等合并、`.kiln-one.bak` 备份与可逆断开。
- 真实 stdio 握手自检（initialize → tools/list → describe → 只读演练）、结构化就绪报告与失败回滚。
- 9 个 `KILN_ONE_*` 错误码与 `KILN_PROJECT_NOT_FOUND`（当时总数 37 个），全部登记且带 `hint` / `docs`。
- 27 个新增测试用例（当时总数 69 个）、性能基准 `npm run bench:one`、4 份产品文档。

### 变更

- `dataPaths()` 基于 `--workspace` 解析数据落点，一键包数据留在包内。
- `FileStore` 增加跨实例缓存失效（版本号 + mtime/size）与串行落盘。
- MCP stdio 服务监听输出流错误，客户端提前断开不再产生未捕获异常。
- 文档与状态同步：README、ARCHITECTURE、INTEGRATION-PLAN、SECURITY。

### 修复

- `grants.file` 子目录授权范围未生效：`{castdata}/exports` 之外与同名前缀目录不再被放行。
- 多 runner / 多进程读到过期的持久化状态。
- 撤销授权后被下一次 `up` 自动恢复。
- Windows 下并发写 `store.json` 触发 `EBUSY`。
- 带时间语义的待办被误分类为账单；`{selected}` 占位符报错误导。
- 拒绝通过同名前缀目录绕过文件路径边界检查。
- 损坏或不可读的持久化存储不再静默回退为空对象。

### 融合层（P2–P7）

- 版本化 artifact：规范化摘要、逐文件哈希、兼容声明、可复现构建与安全解包；`kiln artifact` / `kiln keygen` 与 Ed25519 签名验签。
- 原生 cast 脚手架与宿主生命周期：安装、审批、撤销、运行、面板、更新、卸载，UI 与 agent 共用 `observe` / `act`。
- 安全能力：JSONL 审计回放、子进程隔离执行、超时与环境变量白名单、可选 Node 权限模型、`model` / `agent` 离线驱动、`service` 型入口。
- 远程与发现：HTTP JSON-RPC + SSE MCP 端点与 Bearer 鉴权、`intents` 关键词发现层、按租户隔离数据目录（语义向量检索随后在 P0/P1 段补齐）。
- 跨宿主端到端评测 `npm run eval:fusion`（12/12 通过），报告由该命令生成、不入库。
- 新增 8 个 `KILN_FUSION_*` 错误码（当时总数 45 个），10 个融合层测试用例（当时总数 79 个）。

### 受限执行与分发闭环（P0 / P1）

- **Worker 沙箱**：独立线程执行 cast，`resourceLimits` 限制 V8 堆、超时直接 terminate、崩溃隔离；`kiln sandbox` 与 `kiln invoke --sandbox` 可调配额。
- **`.kiln` 离线包**：gzip + JSON 单文件容器、逐文件哈希、Ed25519 签名、32 MB 上限、防路径穿越；`kiln install / list / uninstall` 安装到 `~/.kiln/apps`，兼容旧 `.kiln.json`。
- **语义化发现**：字符 1–3 gram + 英文词的 256 维 FNV 向量，余弦 + 关键词混合排序；`kiln discover` 支持自然语言寻址。
- **生命周期**：`onMount` / `onUnmount` 由执行器幂等触发，宿主关闭与 Studio 请求结束会清理资源。
- **store 事务**：`ctx.cap.store.transaction()` 在内存草稿上提交，抛错即回滚，落盘串行。
- **Studio 热重载与审计**：按 mtime 破坏 ESM 缓存、SSE 自动刷新、授权勾选写回 `cast.json`（自动备份 + 校验）、审计面板展示能力流水与行级 diff。
- 新增 5 个 `KILN_SANDBOX_*` / `KILN_PACK_*` 错误码（共 50 个），17 个测试（共 96 个）。

### 文档与清理

- 全面汉化：CLI 帮助与错误输出、Studio 与状态面板界面、持续集成与问题模板、示例说明、注释与产品文档；保留技术标识符、品牌名与许可原文。
- 移除全部失效链接：不存在的仓库地址、占位域名与邮箱；错误说明改为指向仓库内 [错误码索引](docs/ERRORS.md)，`$schema` 改为指向 [清单模式](docs/schema/cast-1.json)。
- 修正文档自相矛盾处：插件扩展点数量、能力驱动实现状态、虚构包名、错误码总数、开发机绝对路径与路径分隔符。
- 清理运行时产物（`one/.mcp.json`、`one/.kiln/`）与冗余资源；补齐安装、安全报告、致谢、语言与命名约定等开源上架所需章节。
- 更新全部界面截图并补充状态面板与测试运行截图。
- 开源上架梳理：README 首屏重排与可复制示例、删除待办语气与重复文档索引、统一「当前 / 当时」数字口径、修正 `kiln permissions` 命令语法、补 `.gitattributes` 与 CI 性能门禁、精简通用法普段落。

## [0.1.0] - 2026-11-12

首个可用版本。契约、宿主、插件、Studio 四块打通，全部为本仓库原创实现。

### 新增

**契约（`#pact`）**

- 四动词契约：`describe` / `invoke` / `observe` / `act`，两种形状 `task` 与 `panel`
- `loadCast()` 加载与对齐：清单声明与实现不一致时报 `KILN_PACT_MISMATCH`
- 两个 agent 适配器：`mcp`（结构化工具表，weight 1.0）、`brief`（紧凑提示词，weight 0.45）

**清单与错误（`#grain`）**

- `cast.json` 单文件清单，当时登记 27 个错误码，每条带 `code` / `message` / `hint` / `docs`
- `validateManifest()` 一次返回全部问题，不在首个错误处中止
- 强制示例：每个工具至少一条真实 `call` + `result`

**宿主（`#host`）**

- 能力网关：`shell` / `file` / `store` / `net` 四个句柄，全部经同一出口
- 双向授权求交：清单申请 × 宿主上限，超出部分裁剪并记录 `dropped`
- 拒绝记账：授权拒绝不可被 cast catch 后吞成业务结果
- `observe` 结果按 `budget.observeBytes` 裁剪，被裁字段进 `truncated`
- 插件系统：`addAdapter` / `addCapability` / `addCheck` / `addMiddleware`

**构建（`#forge`）**

- `forge()` 产出契约产物：规范化清单、MCP 工具表、紧凑说明、各适配器视图

**入口（`#surface`）**

- CLI：`check` / `describe` / `invoke` / `observe` / `act` / `forge` / `export` / `plugins` / `studio`
- 全部命令支持 `--json`（单条结果 + `schemaVersion`），退出码 0/1/2

**Studio（`#studio`）**

- 零依赖 HTTP 宿主，扫描目录发现 cast，默认 `127.0.0.1:4310`，端口占用自动顺延
- 三段式界面：cast 列表 / 契约视图 / 运行面板 / 原始清单
- 设计规范页 `/design`：令牌、色阶、字阶、间距、组件
- 深链接 `#/<castId>/<tab>`

**示例**

- `examples/git-lens`：`panel` 型，observe/act，受 shell 白名单约束，git 不可用时优雅降级
- `examples/ledger`：`task` 型，把 65 KB 日志压成 109 B 摘要（ratio 0.0017）

**品牌**

- 标志：外弧窑体 + 拱形炉口，附方形图标与横向锁定
- 设计令牌：`packages/studio/web/tokens.css`

**测试**

- 当时 35 个用例覆盖清单校验、授权求交、执行器、插件、Studio、CLI 退出码

### 已知限制（当时）

- 无沙箱：cast 与宿主同进程，隔离是逻辑边界不是操作系统边界
- `forge` 不打包，不生成可执行产物
- 当时 `surface` 只有 CLI，无 HTTP / stdio 服务端（stdio 在「未发布」段补齐）
- 无多租户、无计量结算、无发现层语义检索
- `entry.kind: "service"` 已进类型，尚无实现
