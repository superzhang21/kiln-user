# Kiln One 接口说明

> 版本：`schemaVersion: 1` · `kiln-one@0.1.0`
> 通用约定：所有命令支持 `--json`，stdout 只输出单条 JSON；诊断走 stderr；退出码 `0` 成功、`1` 有问题、`2` 用法错误。所有错误对象形状为 `{ code, message, hint, docs, detail? }`。

## 1. CLI 接口

`kiln` 入口为 `packages/surface/src/cli.ts`，一键包入口为 `one/kiln-up.mjs`（内部转发到 CLI）。

| 命令                                                            | 主要参数                                                                                                                    | 成功输出关键字段                                                               | 说明                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------- |
| `kiln up [bundle] --json`                                       | `--yes` `--require-approval` `--autostart` `--dev` `--clients <a,b>` `--runtime <dir>` `--skip-register` `--skip-handshake` | `ok, apps, policy, connections, manualConfig, handshake, integrity, nextSteps` | 完整一键启动；`bundle` 省略时为 `./one`  |
| `kiln down [bundle] --json`                                     | —                                                                                                                           | `removed, failed, autostartRemoved`                                            | 移除自己注册的 server 与自启项，保留授权 |
| `kiln status [bundle] --json`                                   | —                                                                                                                           | `installed, connected, permissions, permissionLines, connections, lastCheck`   | 只读状态，不启动运行时                   |
| `kiln seal [bundle] --json`                                     | —                                                                                                                           | `files, checksums`                                                             | 重新生成 sha256 完整性清单               |
| `kiln permissions [bundle] --action show\|grant\|revoke --json` | `--action`                                                                                                                  | `permissions.status, lines`                                                    | 授权状态管理                             |
| `kiln panel [bundle] [--port 4311]`                             | `--port` `--runtime`                                                                                                        | 标准错误输出 `http://127.0.0.1:<port>`                                         | 前台长驻状态面板                         |
| `node one/kiln-up.mjs --status\|--down\|--panel [--json]`       | 透传 `--json` 等                                                                                                            | 同对应 CLI 命令                                                                | 给 agent 的引导入口                      |

`up` 就绪报告示例（节选）：

```json
{
  "ok": true,
  "command": "up",
  "schemaVersion": 1,
  "apps": ["catchall"],
  "policy": "strict",
  "integrity": { "verified": true, "files": 9 },
  "handshake": { "ok": true, "ms": 222, "tools": 13, "describeOk": true, "probeOk": true },
  "connections": [{ "client": "bundle", "configPath": "one/.mcp.json", "serverName": "kiln-one" }],
  "permissionStatus": "granted",
  "manualConfig": "one/.mcp.json"
}
```

失败示例：

```json
{
  "ok": false,
  "command": "up",
  "schemaVersion": 1,
  "issues": [
    {
      "code": "KILN_ONE_INTEGRITY",
      "message": "文件校验失败（可能被修改）: apps/catchall/cast.json",
      "hint": "…",
      "docs": "…"
    }
  ]
}
```

## 2. MCP 工具接口（stdio）

`kiln mcp <bundle>/apps --policy strict --workspace <bundle>` 暴露 13 个工具。协议版本 `2025-11-25`（兼容 `2024-11-05`、`2025-03-26`、`2025-06-18`），`stdout` 只写 JSON-RPC。

| 工具名                          | 动词     | 参数                                                     | 返回要点                                                                                    |
| ------------------------------- | -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `catchall__describe`            | describe | —                                                        | `id / version / title / summary / shape / intents`                                          |
| `catchall__observe`             | observe  | —                                                        | `fields{view,total,open,today,dueSoon,byKind,lastAt,pinned,recent,tip}`、`truncated?`、`at` |
| `catchall__invoke__capture`     | invoke   | `text`, `title?`, `kind?`, `tags?`, `due?`               | `ok, id, dedup, kind, total, truncated?`                                                    |
| `catchall__invoke__find`        | invoke   | `query?`, `kind?`, `limit?`, `includeDone?`              | `ok, query, total, limit, rows[]`                                                           |
| `catchall__invoke__digest`      | invoke   | `period?: "day"\|"week"`                                 | `ok, from, added, done, open, byKind, highlights, bytes`                                    |
| `catchall__invoke__stats`       | invoke   | —                                                        | `ok, total, open, done, pinned, byKind, lastAt, indexBytes, view`                           |
| `catchall__invoke__get`         | invoke   | `id`                                                     | `ok, item` 或 `ok:false, reason`                                                            |
| `catchall__invoke__remove`      | invoke   | `id`                                                     | `ok, removed, total`                                                                        |
| `catchall__invoke__export_list` | invoke   | `format?: "md"\|"json"`, `scope?: "all"\|"open"\|"done"` | `ok, path, bytes, rows, truncated`                                                          |
| `catchall__act__set-view`       | act      | `period: "day"\|"week"\|"all"`                           | `ok, state, note`                                                                           |
| `catchall__act__mark-done`      | act      | `id`                                                     | `ok, state, note`（幂等）                                                                   |
| `catchall__act__pin`            | act      | `id`, `on?`                                              | `ok, state, note`                                                                           |
| `catchall__act__clear-done`     | act      | `confirm: true`                                          | `ok, state, note`；缺 `confirm` 时拒绝且状态不变                                            |

约定：

- `kind` 只能是 `todo | link | bill | note | idea`；`due` 必须是合法 `YYYY-MM-DD`。
- `limit` 被收敛到 `1..10`；`text` 截断到 8000 字符、`title` 120、`tags` 最多 8 个。
- 工具的 `ok: false` 是业务结果，不是崩溃；`reason` / `note` 可直接转述给用户。
- `act` 自带最新 `state`，无需再调 `observe`；未声明的动作由 runner 在 `KILN_PACT_MISMATCH` 处拒绝。
- 业务错误允许转成结构化结果；**越权拒绝不可被吞**（网关记账后覆盖返回值）。

## 3. 状态面板 HTTP API

默认 `http://127.0.0.1:4311/`，只监听本机；带非本机 `Origin` 的请求返回 `403`。

| 路由               | 方法 | 请求体                                      | 响应                                                              |
| ------------------ | ---- | ------------------------------------------- | ----------------------------------------------------------------- |
| `/`                | GET  | —                                           | HTML 面板                                                         |
| `/api/status`      | GET  | —                                           | `StatusReport`                                                    |
| `/api/config`      | GET  | —                                           | `{ ok, config }`（`up.json` 内容）                                |
| `/api/permissions` | POST | `{ "action": "grant" \| "revoke" }`         | `PermissionReport`；非法 action `400`                             |
| `/api/connections` | POST | `{ "action": "disconnect" \| "reconnect" }` | `DownReport` / `ReadyReport`；授权被撤销时 `reconnect` 返回 `409` |
| `/api/handshake`   | POST | `{}`                                        | `{ ok, handshake }`                                               |
| 其它               | —    | —                                           | `404`                                                             |

请求体上限 64 KB，非 JSON 或根非对象返回 `400`。所有错误响应统一为 `{ ok: false, issues: [...] }`。

## 4. 配置文件规范

### `one/up.json`

| 字段                                   | 类型                                   | 说明                               |
| -------------------------------------- | -------------------------------------- | ---------------------------------- |
| `schemaVersion`                        | `1`                                    | 配置版本，其它值拒绝               |
| `id` / `version` / `title`             | string                                 | 包标识，参与完整性清单             |
| `appsDir` / `dataDir`                  | string                                 | 包内相对路径，禁止 `..` 与绝对路径 |
| `policy`                               | `strict \| local \| relaxed`           | 默认 `strict`                      |
| `clients`                              | `"auto" \| "none" \| string[]`         | 自动探测 / 不注册 / 指定客户端     |
| `autostart`                            | boolean                                | 是否默认写开机自启项               |
| `handshake.timeoutMs`                  | 1000–120000                            | 自检超时                           |
| `handshake.probeTool` / `describeTool` | string                                 | 自检使用的只读工具与 describe 工具 |
| `handshake.protocolVersion`            | string                                 | MCP 协议版本                       |
| `permissions[]`                        | `{ capability, scope, human, reason }` | 人类可读权限清单                   |

### `one/checksums.json`

```json
{
  "schemaVersion": 1,
  "generatedAt": "ISO-8601",
  "algorithm": "sha256",
  "bundle": "kiln-one@0.1.0",
  "files": { "AGENT.md": "<hex>", "apps/catchall/cast.json": "<hex>" }
}
```

覆盖固定根文件与 `appsDir` 下全部文件；排除 `.kiln/`、`.mcp.json`、`checksums.json` 自身。校验会同时检查缺失、哈希不符、未登记文件与包版本不一致。

### `one/.mcp.json`（运行时生成，可导入任意客户端）

```json
{
  "mcpServers": {
    "kiln-one": {
      "command": "<node 绝对路径>",
      "args": [
        "<repo>/packages/surface/src/cli.ts",
        "mcp",
        "<bundle>/apps",
        "--policy",
        "strict",
        "--workspace",
        "<bundle>"
      ]
    }
  }
}
```

注册到客户端配置时采用**合并写入**：保留其它 `mcpServers` 与任意顶层字段，首次修改前生成 `<file>.kiln-one.bak`。

### `one/.kiln/state/one-state.json`

```json
{
  "schemaVersion": 1,
  "bundle": "<bundle 绝对路径>",
  "permissions": { "status": "granted", "grantedAt": "ISO-8601", "source": "bundle-delivery", "policy": "strict" },
  "connections": [{ "client": "bundle", "configPath": "...", "serverName": "kiln-one", "addedAt": "ISO-8601" }],
  "lastCheck": { "ok": true, "at": "ISO-8601", "ms": 222, "tools": 13 },
  "autostart": null
}
```

`permissions.status`：`pending`（首次，交付即授权）→ `granted` → `revoked`（必须显式恢复）。状态文件采用临时文件 + rename 原子写；损坏时返回 `KILN_ONE_STATE` 而不是静默重置。

### `one/.kiln/data/catchall/store.json`

每应用独立 KV。`item:c_<12 hex>` 存完整记录，`index` 存精简索引（含 `q` 检索串与 `snippet`），`view` 存观察窗口。索引与记录数不一致时自动从记录重建。

## 5. 错误码

| 码                       | 含义                       | 修复提示要点                                  |
| ------------------------ | -------------------------- | --------------------------------------------- |
| `KILN_ONE_BUNDLE`        | `up.json` 或应用目录有问题 | 修正后 `kiln seal`                            |
| `KILN_ONE_INTEGRITY`     | 缺失 / 篡改 / 未登记文件   | 确认改动后 `kiln seal`，否则换回原始包        |
| `KILN_ONE_APPROVAL`      | 未授权或已撤销             | `kiln permissions <bundle> --action grant`    |
| `KILN_ONE_CLIENT`        | 客户端配置不可读           | 修复 JSON / `mcpServers`，Kiln 不覆盖损坏配置 |
| `KILN_ONE_HANDSHAKE`     | 自检未通过                 | `kiln check` 查契约，或手动跑 `kiln mcp`      |
| `KILN_ONE_RUNTIME`       | Node 版本或内核路径不对    | Node ≥22.18，设置 `KILN_HOME`                 |
| `KILN_ONE_STATE`         | 状态文件损坏               | 备份删除后重跑 `kiln up`                      |
| `KILN_ONE_AUTOSTART`     | 自启项写入失败             | 检查权限或用 `KILN_ONE_AUTOSTART_DIR`         |
| `KILN_ONE_USAGE`         | 命令/请求参数错误          | 见 `--help` 或 API 表                         |
| `KILN_PROJECT_NOT_FOUND` | 找不到 cast 或面板路由     | 确认 Studio 根目录与请求路径                  |

全部 50 个错误码的说明、修复建议与锚点见 [错误码索引](./ERRORS.md)；`issue.docs` 字段即指向该文档的相对地址。既有内核错误码继续遵循 [PACT.md](./PACT.md) 与 `packages/grain/src/codes.ts`。

## 6. 环境变量

| 变量                                        | 用途                                              | 默认             |
| ------------------------------------------- | ------------------------------------------------- | ---------------- |
| `KILN_HOME`                                 | kiln 仓库根目录（一键包不在仓库内时必填）         | 一键包父目录     |
| `KILN_ONE_BUNDLE`                           | 默认 bundle 路径                                  | `./one`          |
| `KILN_ONE_HOME`                             | 覆盖用户主目录（探测客户端、测试隔离）            | 系统主目录       |
| `KILN_ONE_CLIENT_CONFIG`                    | 追加自定义客户端配置路径（`path.delimiter` 分隔） | 无               |
| `KILN_ONE_CLIENTS`                          | 覆盖 `up.json` 的 `clients`                       | `up.json`        |
| `KILN_ONE_AUTOSTART_DIR`                    | 覆盖自启项目录（测试隔离）                        | 平台默认启动目录 |
| `KILN_BENCH_RECORDS` / `KILN_BENCH_QUERIES` | 性能基准规模                                      | `300` / `100`    |
