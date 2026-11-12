# Kiln 独立化架构与交付说明

> 本文回答四件事：**整体架构怎么分层、模块怎么划、任意 agent 怎么接、跨平台与运行环境怎么兼容**；最后给出**交付范围**与**验收标准**。
>
> 说明：本轮在同一仓库内把 Kiln 收敛为「可独立分发、可单机部署、不依赖任何外部框架」的形态。仓库名仍为 `kiln`；如需另起独立仓库或改名，是一次纯迁移动作，不影响本文的模块边界与接口契约。

---

## 1. 定位与独立性边界

Kiln 是一个**面向 agent 的本地微应用运行时**：把「一个工具」抽象成一份声明（`cast.json`）+ 一个四动词契约（`describe / invoke / observe / act`），然后用同一份契约喂给构建、宿主和任意 agent。

独立性由三条硬约束保证：

1. **运行时零依赖**。`dependencies` 为空，只有 3 个 devDependencies（`typescript` / `prettier` / `@types/node`）。安装不联网、无 postinstall、无原生模块。
2. **无外部框架耦合**。不读取任何第三方框架的约定文件（如 `cell.yml`），不 import 任何外部 SDK；`cast` 脚手架是 Kiln 原生生成。
3. **可直接用 `node` 跑源码**。要求 Node ≥ 22.18（内置类型擦除），因此 `node packages/surface/src/cli.ts ...` 即是完整程序，不需要构建产物。

> 边界声明：Kiln 不是 OS 级沙箱。默认执行与宿主同进程，能力网关只能约束「走 `ctx.cap` 的路径」；不可信代码请用 `kiln sandbox` / 子进程隔离，并自行评估风险。

---

## 2. 整体架构

依赖严格单向向下；上层不知道下层的实现，下层不知道上层的存在。

```
┌──────────────────────────────────────────────────────────────┐
│ 接入面  agents / coding-agent                                 │
│  · AgentBridge（进程内）  · HTTP 网关  · MCP stdio             │
│  · 描述投影：mcp / openai / plain                              │
├──────────────────────────────────────────────────────────────┤
│ 入口面  surface（CLI）        studio（本地 HTTP 工作台）        │
├──────────────────────────────────────────────────────────────┤
│ 宿主面  host：执行器 CastRunner · 能力网关 · 策略 · 插件注册表   │
├──────────────────────────────────────────────────────────────┤
│ 契约面  pact：四动词 · 加载 · 校验 · 适配器导出                  │
├──────────────────────────────────────────────────────────────┤
│ 烧制面  forge：校验 → 契约产物（不打包）                        │
├──────────────────────────────────────────────────────────────┤
│ 原料面  grain：清单 schema · 错误码 · 结构化错误                 │
├──────────────────────────────────────────────────────────────┤
│ 基础面  platform：OS / Node / Shell / 路径 探测（新增）          │
└──────────────────────────────────────────────────────────────┘
```

`fusion`（打包 / 宿主生命周期 / 沙箱 / 语义发现）与 `one`（一键包编排）位于内核之上，只向下调用，不改四动词语义。

### 一次调用怎么走

```
agent（任意形态）
  │  ① 拿描述：kiln agents / GET /tools/list / MCP tools/list
  │  ② 发调用：AgentBridge.callTool / POST /tools/call / MCP tools/call
  ▼
surface → pact（确认已声明）→ host（解析授权、造句柄、跑动词、按预算裁剪）
  ▼
cast 业务代码，只能通过 ctx.cap（shell / net / file / store）触碰外部世界
  ▼
返回结构化结果；越权另记账本，动词返回后覆盖结果并抛出
```

---

## 3. 模块划分

| 模块     | 路径                    | 只做一件事                                                         | 明确不做                 | 依赖              |
| -------- | ----------------------- | ------------------------------------------------------------------ | ------------------------ | ----------------- |
| 基础     | `packages/platform`     | 探测 OS / 架构 / Node / Shell / 家目录；路径归一化                 | 不碰业务、不读写用户数据 | 无                |
| 原料     | `packages/grain`        | 清单类型与校验、错误码、`KilnError`                                | 不读入口代码、不碰运行时 | —                 |
| 烧制     | `packages/forge`        | 校验后产出契约产物                                                 | 不打包、不部署           | grain, pact       |
| 契约     | `packages/pact`         | 加载 cast、对齐声明与实现、投影成各家形状                          | 不执行副作用、不做授权   | grain             |
| 宿主     | `packages/host`         | 授权判定、能力注入、执行四动词、插件装载                           | 不知道 agent 是谁        | grain, pact       |
| 入口     | `packages/surface`      | 命令、参数、退出码、输出格式                                       | 不含业务逻辑             | 全部              |
| 工作台   | `packages/studio`       | 本地 HTTP 界面：看契约、跑一次、改权限                             | 不是生产服务             | pact, host        |
| 接入     | `packages/agents`       | 进程内 `AgentBridge`；mcp / openai / plain 三种描述投影；HTTP 网关 | 不含业务、不含模型       | grain, pact, host |
| 内置代理 | `packages/coding-agent` | 可选的工具调用循环；OpenAI 兼容 chat（可注入）；Pi 引擎可选        | 默认不启用、不绑定厂商   | grain, agents     |
| 脚手架   | `packages/fusion`       | `kiln new` / `kiln cast init` 的模板与文件生成                     | 不参与运行时调用链       | grain             |
| 融合     | `packages/fusion`       | artifact 打包签名、宿主生命周期、Worker/子进程隔离、语义发现       | 不改变内核契约           | 内核              |
| 一键包   | `packages/one` + `one/` | 启动编排、授权、客户端注册、握手自检、状态面板                     | 不塞业务进内核           | 内核              |

**新增三个模块的理由**：

- `platform` 把散落的 `process.platform === "win32"`、路径分隔符、shell 差异收拢到一处，跨平台策略只需改这一个文件。
- `agents` 是「任意 agent 接入」的**唯一入口**：描述投影和传输通道都在这里，内核不需要知道对面是什么 agent。
- `coding-agent` 是「可选内置代理」：它只是 `agents` 的一个消费者，删掉它不影响任何其他模块。

---

## 4. Agent 接入方式（四条路，按场景选）

所有接入方式共享同一份契约：工具名形如 `<cast>__invoke__<tool>`，`describe / observe / act` 各有一个固定名。区别只在**传输**与**描述格式**。

### 4.1 决策树

```
你的 agent 支持 MCP 吗？
├─ 是 → 用 MCP stdio（kiln mcp / one 自动写配置）
└─ 否 → 它能发 HTTP 吗？
        ├─ 能 → 用通用 HTTP 网关（kiln serve）
        └─ 不能 → 它在同一进程里吗？
                ├─ 是 → 直接用 AgentBridge（import "#agents"）
                └─ 否 → 先给它一个 HTTP 客户端；Kiln 不要求 SDK
描述格式：要工具表 → mcp / openai / plain 任选（kiln agents --format ...）
```

### 4.2 MCP stdio（Claude Desktop / Cursor / 任何 MCP 客户端）

```bash
node packages/surface/src/cli.ts mcp examples --workspace .
```

`one/kiln-up.mjs` 会自动把配置写进已安装的客户端（跨平台路径见 `packages/one/src/clients.ts`），并保留一份可导入的 `.mcp.json`。

### 4.3 通用 HTTP 网关（任意语言 / 任意运行时）

```bash
node packages/surface/src/cli.ts serve examples --port 4312 --token dev-secret
```

| 方法           | 路径          | 作用                                     |
| -------------- | ------------- | ---------------------------------------- |
| `GET`          | `/health`     | 存活性与工具数                           |
| `GET` / `POST` | `/describe`   | 自描述（`kiln.agent/1`）                 |
| `GET` / `POST` | `/tools/list` | 工具清单（JSON Schema）                  |
| `POST`         | `/tools/call` | 调用：`{"name":"...","arguments":{...}}` |

- 默认只监听 `127.0.0.1`；设置 `--token` 后要求 `Authorization: Bearer <token>`。
- 业务失败返回 HTTP 200 + `{ ok:false, error:{ code, message, hint, docs } }`，让 agent 按结构化错误修正，而不是猜状态码。
- 只要目标语言能发 HTTP，就能接入：Python / Go / Rust / Java / shell / 另一个 Node 进程都一样。

**三道闸门**（多人共用或暴露到局域网时才真正重要）：

| 闸门     | 参数            | 默认     | 超出时的响应                            |
| -------- | --------------- | -------- | --------------------------------------- |
| 鉴权     | `--token`       | 关       | `401`                                   |
| 限流     | `--rate-limit`  | 120/分钟 | `429` + `retry-after` + `x-ratelimit-*` |
| 并发     | `--concurrency` | 4        | `429`（立刻拒绝，不排队）               |
| 单次超时 | `--timeout`     | 120000ms | `504`                                   |

**后台运行**：

```bash
kiln serve examples --port 4312 --detach    # 脱离终端，pid/日志落 .kiln/serve/
kiln serve examples --stop                  # 先 SIGTERM，5 秒未退再 SIGKILL
```

### 4.4 进程内 `AgentBridge`（宿主就是 agent 时）

```ts
import { createAgentBridge } from "#agents";

const bridge = createAgentBridge([{ catalog, runner }]);
const tools = await bridge.listTools();
const result = await bridge.callTool("cast__invoke__tool", { ... });
```

不经过任何序列化边界，适合「你自己写的主程序里嵌入 Kiln」的场景。

### 4.5 描述投影（把契约翻译成对方能吃的样子）

```bash
node packages/surface/src/cli.ts agents examples/git-lens --format openai
node packages/surface/src/cli.ts agents examples/git-lens --format plain
node packages/surface/src/cli.ts agents examples/git-lens --format mcp
```

| 格式     | 形态                                 | 典型消费者                                    |
| -------- | ------------------------------------ | --------------------------------------------- |
| `mcp`    | MCP `tools/list` 载荷                | MCP 客户端                                    |
| `openai` | `[{type:"function",function:{...}}]` | OpenAI / DeepSeek / Ollama / vLLM / LangChain |
| `plain`  | `kiln.agent/1` 自描述 + 工具表       | 任何会读 JSON 的 agent                        |

新增一个生态 = 在 `packages/agents` 里加一个投影函数，**不改内核**。

### 4.6 用户自带的 agent 怎么接（三步）

1. **拿描述**：`--format plain` 或 `GET /tools/list`，得到工具名、用途、参数 JSON Schema、示例。
2. **发调用**：`POST /tools/call`，body `{"name":"<工具名>","arguments":{...}}`。
3. **按错误修正**：失败时读 `error.code / hint`，照做即可；`docs` 指向本地 `docs/ERRORS.md` 锚点。

不需要安装 SDK，不需要理解四动词内部，也不需要知道 Kiln 的存在。

---

## 5. 可选内置 coding agent

**默认关闭，需三重条件同时满足才运行**：

1. 目标 cast 的 `cast.json` 声明 `grants.agent.allow === true`（否则 CLI 直接拒绝）；
2. 显式提供 OpenAI 兼容端点（`--base-url` + `--model`，或 `KILN_MODEL_BASE_URL` / `KILN_MODEL_NAME`）；
3. 用 `kiln code` 显式触发。

```bash
# 本地 Ollama 示例：先被 cast 授权，再指向本地端点
node packages/surface/src/cli.ts code ./my-app \
  --prompt "读取 README，修掉里面的坏链接" \
  --base-url http://127.0.0.1:11434/v1 \
  --model qwen2.5-coder \
  --max-turns 6
```

设计要点：

- **不绑定厂商**：任何 OpenAI 兼容 `/chat/completions` 均可（OpenAI / DeepSeek / Ollama / vLLM / LM Studio）。
- **可注入**：`createCodingAgent({ chat })` 允许替换模型实现；测试不触网。
- **有界**：`maxTurns` 默认 8、硬上限 32；每轮工具调用都走宿主的能力网关与审计，越权同样被拒。
- **可删除**：它只依赖 `agents`，删掉不影响其他模块。

> 安全提示：启用它意味着允许模型读取你授权的文件/命令并按指令操作。请只对可信 cast 开启，并优先使用最小授权（`grants` 里的白名单）。

---

## 6. 跨平台与环境兼容策略

### 6.1 操作系统

| 关注点     | 策略                                                                               | 落点                                            |
| ---------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| OS 识别    | `win32 → windows`、`darwin → macos`、`linux → linux`、其余 `other`                 | `platform.detectOs`                             |
| Shell      | Windows 取 `ComSpec`，类 Unix 取 `$SHELL`，兜底 `cmd.exe` / `/bin/zsh` / `/bin/sh` | `platform.detectShell`                          |
| 路径       | 统一提供 POSIX 风格归一化与绝对路径判断（兼容盘符）                                | `platform.normalizePath` / `isAbsolutePortable` |
| 家目录     | `KILN_ONE_HOME → HOME → USERPROFILE → os.homedir()`                                | `platform.detectRuntime`                        |
| 写文件占用 | Windows 上 `EBUSY/EPERM/EACCES` 短重试                                             | `host/gateway.ts`                               |
| 客户端配置 | Claude Desktop 在 win/mac/linux 三套路径分别解析                                   | `one/clients.ts`                                |
| 命令执行   | `execFile(cmd, args[])`，不拼 shell 字符串，`windowsHide: true`                    | `host/gateway.ts`                               |

### 6.2 运行环境

- **Node ≥ 22.18**：利用内置类型擦除直接运行 `.ts`，因此**无需构建**。`kiln doctor` 会明确报告版本是否达标。
- **零依赖**：不引入原生模块，不依赖 pnpm 工作区协议，安装即用。
- **流式协议**：MCP 读取按行切分并设置 `crlfDelay: Infinity`，兼容 CRLF/LF。
- **编码**：全程 UTF-8；JSON 读写显式 `utf8`。
- **无网络安装**：`npm install` 只拉 3 个 devDependencies；运行时不联网（除你显式启用 coding agent 或 cast 申请 `net` 能力）。

### 6.3 适配矩阵

| 维度           | 支持                               |
| -------------- | ---------------------------------- |
| OS             | Windows / macOS / Linux            |
| Node           | ≥ 22.18（含 23/24）                |
| 传输           | MCP stdio · HTTP JSON · 进程内调用 |
| 描述格式       | mcp · openai · plain               |
| 模型端点       | 任意 OpenAI 兼容（含本地）         |
| 语言（调用方） | 任何能发 HTTP 或解析 JSON 的语言   |

---

## 7. 安装与部署

**方式 A：直接用源码（无需安装）**

```bash
git clone <repo> && cd kiln
node packages/surface/src/cli.ts doctor
node packages/surface/src/cli.ts new demo-app
node packages/surface/src/cli.ts check demo-app
```

**方式 B：全局安装（提供 `kiln` 命令）**

```bash
npm install -g .
kiln doctor
kiln new demo-app
```

**方式 C：单机常驻网关**

```bash
kiln serve /path/to/apps --host 127.0.0.1 --port 4312 --token <secret> --detach
kiln serve /path/to/apps --stop
```

数据落在 `--workspace` 指定的 `.kiln/` 下，复制该目录即可迁移；不写系统目录。

---

## 8. 交付成果范围（本轮）

**已交付（可验证）**

1. `packages/platform`：跨平台运行时探测（OS/架构/Node/Shell/家目录/路径归一化），以及后台进程工具（状态文件 / 存活探测 / 优雅停止）。
2. `packages/agents`：`AgentBridge` 进程内接口；`mcp` / `openai` / `plain` 三种描述投影；工具名规范化。
3. `packages/agents/http.ts`：通用 HTTP 网关（四个端点、Bearer 鉴权、CORS、4 MB 上限），并带**限流 / 并发上限 / 单次超时**三道闸门。
4. `packages/coding-agent`：可选内置 coding agent（OpenAI 兼容、`chat` 可注入、轮次有界、默认关闭），引擎可切内置循环或 Pi。
5. `packages/fusion/scaffold.ts`：`kiln new` 项目生成器，`minimal` / `toolkit` / `panel` 三套模板，产物可直接通过 `check`。
6. CLI 新命令：`new` / `doctor` / `agents` / `serve`（含 `--detach` / `--stop`）/ `code`，并写入 `--help`。
7. 新错误码：`KILN_AGENT_HTTP`、`KILN_CODING_AGENT`、`KILN_MODEL_FAILED`、`KILN_ENGINE_MISSING`（已登记 `codes.ts`）。
8. 测试：`platform` / `agents` / `agents-http` / `coding-agent` / `pi-engine` / `scaffold` / `daemon` 七个新 spec，共 126 项。
9. 文档：`QUICKSTART.md` + 本文 + `AGENTS.md` + `CODING-AGENT.md` + `PLATFORM.md`，并更新 `README.md` / `ARCHITECTURE.md` / `ERRORS.md` / `TESTING.md` / `CHANGELOG.md`；`docs/images/` 补齐 6 张真实运行截图（已脱敏）。

**明确未做（避免误解）**

- 不做 OS/容器级沙箱（仍是逻辑边界 + Worker/子进程隔离）。
- 不内置模型权重，也不代理你的 API Key；coding agent 只提供一个兼容客户端。
- 不提供 SDK 包（HTTP + JSON 已足够；SDK 是后续可选项）。
- 不做 IDE 插件、不做云端多租户计费。

---

## 9. 验收标准

逐条可执行、可复现：

| #   | 验收项            | 命令 / 判据                                                               | 通过标准                                           |
| --- | ----------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | 零运行时依赖      | `node -e "console.log(require('./package.json').dependencies)"`           | 输出 `undefined`                                   |
| 2   | 无第三方运行时库  | `grep -rnE "from \"@[a-z]+\|require\(\"@[a-z]" packages/`                 | 无命中（只有 `node:` 内置模块）                    |
| 3   | 生成即可跑        | `kiln new demo && kiln check demo`                                        | 生成 6 个文件；`check` 退出码 0                    |
| 4   | 契约校验          | `npm run check`                                                           | 两个示例均 `✓`                                     |
| 5   | 跨平台探测        | `kiln doctor`                                                             | 正确输出 OS/Node/Shell；Node < 22.18 退出码 1      |
| 6   | 描述投影          | `kiln agents examples/git-lens --format openai`                           | 输出合法 `type:"function"` 数组                    |
| 7   | HTTP 接入         | `kiln serve ... --token t` 后 `curl -H 'Authorization: Bearer t' /health` | `{ok:true}`；无 token 返回 401                     |
| 8   | 限流生效          | 连发超过 `--rate-limit` 次                                                | 第 N+1 次 `429`，带 `retry-after`                  |
| 9   | 超时生效          | `--timeout 120` 调一个慢工具                                              | `504`，错误说明超时毫秒                            |
| 10  | 后台运行与停止    | `serve --detach` → `serve --stop`                                         | 有 URL/pid；stop 后进程消失、状态文件清除          |
| 11  | 越权仍被拒        | 对未授权工具 `POST /tools/call`                                           | `ok:false` 且 `error.code` 为 `KILN_CAP_DENIED` 等 |
| 12  | coding agent 守卫 | 对未声明 `grants.agent.allow` 的 cast 跑 `kiln code`                      | 退出码 1，报 `KILN_CODING_AGENT`                   |
| 15  | 可独立运行        | 在干净目录 `node packages/surface/src/cli.ts doctor`                      | 不依赖 `node_modules` 也能跑通                     |
| 16  | 可迁移数据        | 复制 `.kiln/` 到另一目录后 `kiln check`                                   | 行为一致                                           |

---

## 10. 后续可选项（不在本轮承诺内）

- 把 `agents` 的 HTTP 网关扩展为 SSE / WebSocket 长连接。
- 为网关补 TLS 与「多 token 分权」（当前只有单一 Bearer token）。
- 增加 JSON-lines 传输，便于嵌入管道与子进程。
- 为 coding agent 增加「只读模式」与「补丁预览」。
- 提供官方 SDK（Node / Python）薄封装。
