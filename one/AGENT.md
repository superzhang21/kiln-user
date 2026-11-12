# Kiln One 一键包 · 给 agent 的接入说明

这是一个自描述的 Kiln 一键包。用户把它交给你，意思是：**请你自动完成连接并启动，不要让用户写配置、装依赖或理解内部概念。**

下面的 JSON 块是机器可读的接入契约；请以实际路径替换 `<bundle>`（本文件所在目录）与 `<repo>`（kiln 仓库根目录）。

```json
{
  "kilnOne": 1,
  "id": "kiln-one",
  "version": "0.1.0",
  "requires": {
    "node": ">=22.18",
    "npmInstall": false,
    "network": false,
    "account": false,
    "apiKey": false
  },
  "start": {
    "command": "node <bundle>/kiln-up.mjs",
    "cwd": "<repo>",
    "json": true,
    "timeoutMs": 60000,
    "idempotent": true
  },
  "verify": {
    "command": "node <bundle>/kiln-up.mjs --status --json",
    "expect": "ok == true && connected == true"
  },
  "stop": {
    "command": "node <bundle>/kiln-up.mjs --down --json"
  },
  "panel": {
    "command": "node <bundle>/kiln-up.mjs --panel --port 4311",
    "url": "http://127.0.0.1:4311/"
  },
  "onFailure": "读取输出中的 issues[]，按每个 hint 执行修复；最多重试一次；仍失败则把 message 与 hint 原样转述给用户，不要自行改写配置或跳过完整性校验。",
  "permissions": [
    "只在本机保存用户交给它的内容",
    "只在自己的数据目录里写导出文件",
    "不联网、不上传任何内容",
    "不执行任何系统命令"
  ],
  "policy": "strict",
  "data": "<bundle>/.kiln/data/catchall/store.json"
}
```

## 你应该做什么

1. 执行 `start.command`。它会一次完成：完整性校验 → 契约校验 → 一次授权 → 自动写入已安装 agent 客户端的 MCP stdio 配置 → 拉起真实 MCP 服务做握手自检 → 输出结构化「就绪报告」。
2. 检查返回的 `ok`、`handshake.ok`、`permissions` 与 `connections`。`handshake.ok === true` 才告诉用户「可以用了」。
3. 向用户展示一次 `permissions` 里的人话清单，并说明可随时撤销：`node <bundle>/kiln-up.mjs --down` 断开连接，`kiln permissions <bundle> --action revoke` 撤销授权。
4. 之后用户用自然语言提需求即可，由你选择调用下面的 MCP 工具；不要要求用户记命令或工具名。

## 可用能力（MCP 工具）

| 用户会说的话                     | 你调用的工具                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| 「把这段存一下 / 记一下」        | `catchall__invoke__capture`，参数 `text`，可选 `title` / `kind` / `tags` / `due`         |
| 「帮我找…」                      | `catchall__invoke__find`，参数 `query`，可选 `limit`（1–10）/ `kind` / `includeDone`     |
| 「今天要做什么」                 | `catchall__observe`（返回预算内小摘要）；也可用 `catchall__act__set-view` 切窗口         |
| 「这周汇总一下」                 | `catchall__invoke__digest`，参数 `period: "week"`                                        |
| 「标记完成 / 置顶 / 清理已完成」 | `catchall__act__mark-done` / `pin` / `clear-done`（`clear-done` 必须带 `confirm: true`） |
| 「导出成文件」                   | `catchall__invoke__export_list`，参数 `format: "md"` 或 `"json"`                         |
| 「删掉这条」                     | `catchall__invoke__remove`，参数 `id`                                                    |

`act` 的返回值自带最新状态，不需要再调一次 `observe`。工具返回的 `ok: false` 是业务结果，不是崩溃：把 `reason` / `note` 转成人话即可。

## 约束

- 不要修改 `up.json`、`checksums.json` 或 `apps/` 下的任何文件。改动后必须运行 `kiln seal <bundle>`，否则启动会被完整性校验拦下。
- 不要给这个包申请网络或 shell 权限，也不要用它运行未审阅的第三方 cast：当前 cast 与宿主同进程，**没有 OS 级沙箱**。
- 数据只在 `<bundle>/.kiln/data/`。备份或迁移只需复制整个 `<bundle>` 目录。
- 失败时不要猜：所有错误都带 `code` / `message` / `hint` / `docs`，照 `hint` 做。
