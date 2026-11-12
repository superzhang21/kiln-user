# 示例应用

两个 cast，覆盖两种形状。

| 目录                    | shape   | 动词                              | 演示重点                                         |
| ----------------------- | ------- | --------------------------------- | ------------------------------------------------ |
| [`git-lens/`](git-lens) | `panel` | describe / invoke / observe / act | 有状态对象、`act` 自校验、shell 白名单、优雅降级 |
| [`ledger/`](ledger)     | `task`  | describe / invoke                 | 大对象压成小结果、文件授权、越权拦截不可吞       |

```bash
npm run check                       # 两个都校验一遍
npm run studio                      # 在 Studio 里点着看
```

## 写自己的 cast

```bash
mkdir examples/my-cast && cd examples/my-cast
```

三个文件：

```
cast.json      声明：我是谁、能做什么、要什么权限
src/pact.ts    实现：describe + invoke（或 observe/act）
README.md      说明：演示什么
```

最小可用清单：

```jsonc
{
  "id": "my-cast",
  "version": "0.1.0",
  "title": "我的微应用",
  "summary": "一句话说明它解决什么问题",
  "intents": ["关键词"],
  "shape": "task",
  "verbs": ["describe", "invoke"],
  "entry": { "kind": "local", "module": "./src/pact.ts" },
  "tools": [
    {
      "name": "do_it",
      "purpose": "做一件事",
      "args": { "input": "string" },
      "examples": [{ "call": { "input": "x" }, "result": { "ok": true } }],
    },
  ],
  "actions": [],
  "grants": {},
}
```

`examples` 是**必填**。没有真实示例的 cast 会被 `kiln check` 拦下——示例是 agent 学一个工具最省 token 的方式。
