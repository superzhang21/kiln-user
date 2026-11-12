# 契约（Pact）

## 四动词

一个 cast 对外的能力，只有四种表达方式。多一种都不要。

| 动词       | 语义                       | 必选     | 典型场景                          |
| ---------- | -------------------------- | -------- | --------------------------------- |
| `describe` | 静态说明：我是谁、能做什么 | **必选** | 任何 agent 决定要不要调用的第一步 |
| `invoke`   | 无状态：给我参数，还你结果 | 可选     | 查询、计算、转换                  |
| `observe`  | 活对象：现在是什么状态     | 可选     | 有界面的应用、有状态的工作区      |
| `act`      | 活对象：按意图推进         | 可选     | 切换视图、提交表单、推进流程      |

两种形状由 `shape` 决定，规则是硬的：

- `shape: "task"` → 必须有 `invoke`
- `shape: "panel"` → 必须有 `observe` **且** `act`

`act` 必须有 `observe` 配对。理由很实际：动作改了状态却读不回来，调用方就只能靠猜，或者干脆再重跑一次——比不让它调用更糟。

## 为什么是这四个

`invoke` 是所有人都想到的。真正的问题是**有状态的东西怎么给 agent 用**。

三条路，代价递增：

1. 让 agent 看截图、点坐标 —— 最通用，最贵，最不可靠
2. 让 agent 调一堆细粒度 API —— 参数空间爆炸，一次操作要好几轮
3. 让应用自己暴露「状态摘要 + 语义动作」—— agent 只发意图，参数由应用自己收敛

第三条就是 `observe` / `act`。它把「agent 操作界面」从**感知问题**降级成**意图问题**。

具体差别：

|                  | 一堆 tool schema | observe / act                    |
| ---------------- | ---------------- | -------------------------------- |
| agent 先读什么   | 全套参数定义     | 少量权威业务字段                 |
| agent 要构造什么 | 完整参数对象     | 一个语义意图（`apply-window`）   |
| 参数合法性谁保证 | 调用方           | **应用自己**，`act` 里校验并拒绝 |
| 一次的往返       | 往往多次         | 一次到位，`act` 直接回新状态     |

`act` 的返回值里带 `state`，就是为此：调用方一轮拿到结果，不必再 `observe` 一次。

## 强制示例

**每个工具必须至少有一条真实示例，`call` 与 `result` 都要有。** 校验器硬性要求，缺了直接报 `KILN_TOOL_NO_EXAMPLE`。

这条是从 token 账上算出来的：agent 学一个工具，绝大部分成本花在**猜参数长什么样**和**猜返回是什么结构**上。一条真实示例抵一千字描述，而且没有歧义。

```json
"examples": [
  {
    "call": { "file": "events.ndjson", "top": 3 },
    "result": { "rows": 800, "summaryBytes": 96, "ratio": 0.0017 }
  }
]
```

示例要**真实**，不要手编理想值。假示例会诱导 agent 按错的结构去解析。

## 清单字段

```jsonc
{
  "$schema": "../../docs/schema/cast-1.json", // 相对本文件；路径随 cast 目录层级调整

  "id": "ledger", // 小写字母开头，字母/数字/短横线，2–48
  "version": "0.1.0",
  "title": "事件账本摘要",
  "summary": "一句话说明它解决什么问题",

  "intents": ["日志", "摘要"], // 供发现层匹配任务，不是给人看的标签

  "shape": "task", // task | panel
  "verbs": ["describe", "invoke"],

  "entry": {
    "kind": "local", // local | service（service 通过 URL 转发四动词）
    "module": "./src/pact.ts", // 相对 cast 目录
  },

  "tools": [
    {
      "name": "digest", // 小写字母开头，字母/数字/下划线
      "purpose": "按 kind 汇总事件",
      "args": { "file": "string?", "top": "number?" }, // ? 表示可选
      "returns": "{ rows, byKind }",
      "examples": [{ "call": {}, "result": {} }], // 至少一条
    },
  ],

  "actions": [{ "name": "apply-window", "purpose": "切换时间窗", "args": ["days"] }],

  "grants": {
    "shell": { "allow": ["git"] }, // 只有命令名，不能带参数
    "net": { "allow": ["api.example.com"] }, // 只有主机名，不能带协议
    "store": { "scope": "cast" },
    "file": { "read": ["{castdata}"], "write": ["{castdata}"] },
    // 融合层提供 model / agent 可插拔离线驱动，默认不发起外部调用
    "model": { "allow": ["fast"], "maxTokens": 4096 },
    "agent": { "allow": false, "maxTurns": 4 },
  },

  "budget": { "observeBytes": 2048, "tools": 6, "actions": 8 },
}
```

### 路径占位符

只有四个，写别的直接报错：

| 占位符        | 指向                       |
| ------------- | -------------------------- |
| `{castdata}`  | 该 cast 独占的数据目录     |
| `{workspace}` | 当前工作区                 |
| `{selected}`  | 用户通过对话框选的路径     |
| `{home}`      | 用户主目录（高风险，慎用） |

规则：**占位符必须在路径开头**。`{castdata}/a.json` 合法，`/tmp/{castdata}` 不合法。这条是防绕过的第一道闸——先卡形式，再卡前缀匹配。

### shell / net 白名单的写法

- `shell.allow` 每条只能是**命令名**（`git`），不能是 `"git log --oneline"`。参数写在代码里，宿主按数组传参，不拼 shell 字符串。
- `net.allow` 每条只能是**主机名**，可带端口（`api.example.com:443`），不能带协议、路径、通配符。

这两条限制不是洁癖。`"git log; rm -rf /"` 这种写法如果被接受，白名单就形同虚设。

## 校验规则一览

`kiln check` 一次跑完全部，按 code 分组返回。

| 错误码                   | 触发条件                                  |
| ------------------------ | ----------------------------------------- |
| `KILN_MANIFEST_FIELD`    | 字段缺失或类型不对                        |
| `KILN_MANIFEST_ID`       | id 格式不合规                             |
| `KILN_SHAPE_MISMATCH`    | shape 与 verbs 不自洽                     |
| `KILN_VERB_NO_DESCRIBE`  | verbs 没有 describe                       |
| `KILN_VERB_ORPHAN`       | 声明了动词但对应列表为空                  |
| `KILN_VERB_PAIR`         | 有 act 没 observe                         |
| `KILN_TOOL_NAME`         | 工具名不合规或重名                        |
| `KILN_TOOL_NO_EXAMPLE`   | 工具缺示例，或示例不完整                  |
| `KILN_ACTION_NAME`       | 动作名不合规或重名                        |
| `KILN_BUDGET_EXCEEDED`   | 工具/动作数或 observe 体积超预算          |
| `KILN_GRANT_UNKNOWN`     | 声明了六类之外的能力                      |
| `KILN_GRANT_PATHVAR`     | 路径缺占位符，或占位符不在开头            |
| `KILN_GRANT_SHELL`       | shell 项带参数或非法字符                  |
| `KILN_GRANT_NET`         | net 项带协议/路径/通配符                  |
| `KILN_ENTRY_MISSING`     | 入口模块不存在                            |
| `KILN_ENTRY_EXPORT`      | 入口没导出 pact，或导出物不合法           |
| `KILN_PACT_MISSING_VERB` | verbs 声明了但 pact 没实现                |
| `KILN_PACT_MISMATCH`     | 实现了未声明的动词、调了未声明的工具/动作 |

每条错误都有 `code` / `message` / `hint` / `docs`。`hint` 是一句可执行的修复建议，不是「请检查配置」这种废话。

## 写一个 pact

```ts
import type { CastPact, CastContext, Observation } from "#pact";

export const pact: CastPact = {
  describe() {
    return { id: "ledger", version: "0.1.0", title: "...", summary: "...", shape: "task", intents: ["日志"] };
  },

  async invoke(tool, args, ctx: CastContext) {
    // 只能通过 ctx.cap 触碰外部世界
    const text = await ctx.cap.file.read("{castdata}/events.ndjson");
    return { rows: text.split("\n").length };
  },
};
```

入口也可以导出工厂 `(manifest) => pact`，两者都接受。

### cast 能碰什么

只有 `ctx.cap` 上的四样，没有 `node:fs`、没有裸 `fetch`：

| 句柄        | 方法                                             |
| ----------- | ------------------------------------------------ |
| `cap.shell` | `(command, args[], { cwd, timeoutMs })`          |
| `cap.file`  | `read` / `write` / `list`，路径必须带占位符      |
| `cap.store` | `read` / `write` / `drop` / `keys`，每应用 KV    |
| `cap.net`   | `(url, { method, body, headers })`，受域名白名单 |

这不是「建议」，是唯一通道。想绕过去就得先改网关，而网关是宿主的地盘。

## observe 的预算

`observe` 的返回会被按 `budget.observeBytes` 裁剪。超了不报错，而是**按字段逐个丢弃**，被丢的字段名进 `truncated`。

不静默丢数据是刻意的：调用方看到 `truncated` 就知道「还有更多」，可以换更窄的查询再来一次，而不是误以为这就是全部。
