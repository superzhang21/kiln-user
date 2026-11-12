# coding agent（可选，可换引擎）

Kiln 自带一个**可选的**编码代理：把「模型 + 工具」的循环做进仓库，但**默认关闭**，且不绑定任何厂商或运行时。

它由两个互不纠缠的部件组成：

```
决策器（引擎）  负责「下一步调什么工具」  ← 可替换：builtin / pi
工具面（bridge）负责「真的去执行」        ← 固定：永远走 Kiln 的能力网关
```

**换引擎不会改变「谁能调什么」。** 任何引擎拿到的工具表都来自 `AgentBridge`，都要经过授权、配额与审计。

## 两种引擎

|          | `builtin`              | `pi`                                                   |
| -------- | ---------------------- | ------------------------------------------------------ |
| 依赖     | 零（只用全局 `fetch`） | 需 `@earendil-works/pi-agent-core`                     |
| 循环     | 单轮工具调用循环       | Pi 的 Agent 运行时                                     |
| 会话     | 一次性                 | 树状历史、上下文压缩                                   |
| Provider | OpenAI 兼容            | 由 Kiln 注入一个 OpenAI 兼容 provider                  |
| 工具     | cast 的工具            | cast 的工具（**不含** Pi 自带的 read/bash/edit/write） |
| 何时用   | 默认；任何环境         | 需要更强循环、上下文管理时                             |

`--engine auto`（默认）会探测 Pi：装了就用 Pi，没装就用 builtin。显式写 `--engine pi` 但没装，会直接报 `KILN_ENGINE_MISSING`，**不会静默回落到 builtin** —— 避免「以为在用 Pi，其实跑的是内置循环」。

### 为什么 Pi 不带自己的工具

Pi 的 `pi-coding-agent` CLI 自带 `read` / `bash` / `edit` / `write`，这些工具以**宿主用户权限**直接操作文件与 shell，没有权限系统。如果把它们原样接进来，模型可以绕过 `grants` 直接 `cat ~/.ssh/id_rsa`，Kiln 的能力网关就形同虚设。

所以这里只使用 `pi-agent-core` 的 `Agent`（一个可注入工具的运行时），工具表完全由 Kiln 提供。测试 `P2` 会断言这一点：模型拿到的工具里不出现 `read` / `bash` / `edit` / `write` / `powershell` / `grep` / `find` / `ls`。

## 三个前置条件

1. 目标 cast 的 `cast.json` 声明：

   ```json
   { "grants": { "agent": { "allow": true } } }
   ```

2. 提供一个 **OpenAI 兼容**端点（任意厂商 / 本地模型均可）：

   ```bash
   export KILN_MODEL_BASE_URL=http://127.0.0.1:11434/v1   # Ollama
   export KILN_MODEL_NAME=qwen2.5-coder
   ```

3. 显式运行 `kiln code`（缺省不会自动触发）。

## 用法

```bash
# 默认：自动选择引擎
node packages/surface/src/cli.ts code ./my-app \
  --prompt "读取 README，修掉坏链接，并说明改了什么" \
  --base-url http://127.0.0.1:11434/v1 \
  --model qwen2.5-coder \
  --max-turns 6 \
  --json
```

| 参数          | 含义                           | 默认                  |
| ------------- | ------------------------------ | --------------------- |
| `--prompt`    | 任务描述（必填）               | —                     |
| `--base-url`  | OpenAI 兼容根路径（到 `/v1`）  | `KILN_MODEL_BASE_URL` |
| `--model`     | 模型名                         | `KILN_MODEL_NAME`     |
| `--api-key`   | 端点密钥（本地模型通常不需要） | —                     |
| `--engine`    | `auto` / `builtin` / `pi`      | `auto`                |
| `--max-turns` | 工具循环上限                   | 8（硬上限 32）        |

装上 Pi：

```bash
npm i -D @earendil-works/pi-agent-core
node packages/surface/src/cli.ts doctor      # 会显示 pi 是否可用
```

## 它怎么工作

```
prompt
  ▼
列出可用工具（来自 AgentBridge，即 cast 的四个动词）
  ▼
循环 ≤ maxTurns：
  引擎决定下一个动作
    ├─ 不再调工具 → 收尾，返回文本
    └─ 调工具     → bridge.callTool（走能力网关 + 审计）
                   → 结果回填 → 下一轮
```

- 每次工具调用都经过能力网关，越权同样被拒并记账。
- 工具失败不会中断循环：失败原因回填给模型，由它决定下一步（`error.code` / `hint` 就在里面）。
- 达到轮次上限会停止，标记 `stoppedBy: "maxTurns"`。
- 模型端点报错时**向上抛出** `KILN_MODEL_FAILED`，不会返回一个看起来成功的结果。

## 编程接口

```ts
import { createAgentBridge } from "#agents";
import { createEngine } from "#coding-agent";

const engine = await createEngine({
  bridge: createAgentBridge([{ catalog, runner }]),
  provider: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder" },
  engine: "auto",
  maxTurns: 6,
});

const result = await engine.run("把 README 的坏链接修掉");
// { ok, output, turns, steps, stoppedBy, engine, model }
```

想固定用零依赖的实现：

```ts
import { createBuiltinEngine } from "#coding-agent";

const engine = createBuiltinEngine({
  bridge,
  provider: { baseUrl: "http://localhost", model: "m" },
  chat: async (req) => ({ content: "完成", toolCalls: [] }), // 可注入，测试不触网
});
```

`createCodingAgent(...)` 是 `createBuiltinEngine(...)` 的兼容别名。

## 排障

引擎「跑完了但什么都没做」时，打开诊断日志：

```bash
KILN_DEBUG=1 node packages/surface/src/cli.ts code ./my-app --prompt "..." ...
```

会输出引擎装配、每次 `streamFn` 调用、以及 `agent_end` 的 `stopReason` 与错误信息。

## 安全边界

- **默认关闭**：不声明 `grants.agent.allow` 直接拒绝（`KILN_CODING_AGENT`）。
- **最小授权**：把 `grants` 里的 shell / net / file 白名单收到刚好够用。
- **不代管密钥**：Kiln 不保存你的 API Key，只在调用时放进请求头。
- **不给引擎宿主权限**：引擎只能看见 cast 的工具，碰不到 Pi 自带的文件 / shell 工具。
- **不保证正确性**：模型会产生错误操作，务必在可回滚的环境（git 工作区）里使用。
