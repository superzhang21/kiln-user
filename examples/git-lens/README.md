# Git 洞察面板（git-lens）

panel 型 cast 的参考实现：有状态、可观察、可推进。

```bash
node ../../packages/surface/src/cli.ts check .
node ../../packages/surface/src/cli.ts observe . --json
node ../../packages/surface/src/cli.ts act . apply-window --args '{"days":30}' --json
```

## 它演示什么

- **`observe` / `act` 配对**：`act` 返回新状态，调用方一轮拿到结果，不必再 observe 一次。
- **参数自己收敛**：`days` 必须在 1–365，越界时 `act` 直接拒绝且不改状态，调用方一次就知道边界。
- **能力最小化**：`grants.shell.allow` 只有 `git` 一个命令，参数写在代码里，宿主按数组传参。
- **优雅降级**：git 不可用时返回 `{ ok: false, reason }`，不抛栈。所以这台机器上没装 git 也能跑通全部动词。

## 清单要点

```jsonc
"shape": "panel",
"verbs": ["describe", "invoke", "observe", "act"],
"grants": { "shell": { "allow": ["git"] }, "store": { "scope": "cast" } }
```

`store` 用来记住当前时间窗，落在 `.kiln/data/git-lens/store.json`。

## 试一下严格策略

```bash
node ../../packages/surface/src/cli.ts observe . --policy strict --json
```

会得到 `KILN_CAP_DENIED`，附一句为什么：宿主对 shell 要求人工确认，而当前是非交互环境。
