# Kiln One 部署、使用与维护

> 适用版本 `kiln-one@0.1.0` · 平台 Windows / macOS / Linux · 运行时零依赖。

## 1. 环境要求

| 项           | 要求                                                                           |
| ------------ | ------------------------------------------------------------------------------ |
| Node.js      | `>=22.18`（直接运行 `.ts`，无需编译、无需构建步骤）                            |
| 运行时依赖   | 无（仅 Node 内置模块）                                                         |
| 可选开发依赖 | 仅开发仓库需要：`npm test` / `npm run typecheck` / `npm run format:check` |
| 网络         | 不需要；默认应用不联网、不上传数据                                             |
| 账号 / 密钥  | 不需要                                                                         |
| MCP 客户端   | 任一支持 stdio MCP 的 agent 客户端；未安装时仍会生成可导入配置                 |

一键包默认位于仓库 `one/`，通过相对路径找到 `packages/surface/src/cli.ts`。**若把 `one/` 单独复制到别处**，必须设置 `KILN_HOME` 指向 kiln 仓库根目录，或让包与仓库同级：

```cmd
set KILN_HOME=<kiln 仓库根目录>
node one/kiln-up.mjs --json
```

```sh
KILN_HOME=/path/to/kiln node one/kiln-up.mjs --json
```

## 2. 部署与首次启动

三种等价入口，都走同一条 `kiln up` 流程：

1. **交给 agent（推荐）**：把 `one/` 文件夹拖进对话。agent 读取 `AGENT.md` 后执行 `node <bundle>/kiln-up.mjs`，自动完成连接、授权与自检。
2. **双击**：Windows 运行 `one/kiln-up.cmd`；macOS / Linux 运行 `one/kiln-up.sh`。
3. **命令行**：`node packages/surface/src/cli.ts up one --json`。

首次启动依次发生：

1. 完整性校验（`checksums.json`）；
2. 契约校验（每个 `cast.json` 与 `pact.ts` 对齐）；
3. 一次授权：权限清单为「只在本机保存内容 / 只在自己的数据目录写导出文件 / 不联网 / 不执行命令」，默认策略 `strict`；
4. 自动探测已安装的客户端配置并合并写入 `mcpServers.kiln-one`（幂等），同时生成包内 `one/.mcp.json`；
5. 拉起真实 MCP stdio 服务自检：`initialize` → `tools/list` → `describe` → 只读 `stats`；
6. 输出就绪报告。`handshake.ok === true` 才表示可用。

未发现已安装客户端时不会报错：报告里给出 `manualConfig` 路径，把 `one/.mcp.json` 交给 agent 或导入客户端即可。任何一步失败都会输出带 `hint` 的结构化问题，并且**自检失败会回滚刚写入的连接**。

常用运维命令：

```cmd
node packages/surface/src/cli.ts status one --json
node packages/surface/src/cli.ts up one --json
node packages/surface/src/cli.ts down one --json
node packages/surface/src/cli.ts permissions one --action show --json
node packages/surface/src/cli.ts panel one --port 4311
```

## 3. 日常使用

用户只需要说自然语言，由 agent 选工具：

| 用户说                           | agent 调用                                        |
| -------------------------------- | ------------------------------------------------- |
| 「把这段地址存一下」             | `catchall__invoke__capture`                       |
| 「帮我找上个月的房租发票」       | `catchall__invoke__find`                          |
| 「今天要做什么」                 | `catchall__observe` / `catchall__act__set-view`   |
| 「这周汇总一下」                 | `catchall__invoke__digest`                        |
| 「标记完成 / 置顶 / 清理已完成」 | `catchall__act__mark-done` / `pin` / `clear-done` |
| 「导出成文件」                   | `catchall__invoke__export_list`                   |

也可以不走 agent 直接调用：

```cmd
node packages/surface/src/cli.ts invoke one\apps\catchall capture --args "{\"text\":\"明天交周报\"}" --workspace one --policy strict --json
node packages/surface/src/cli.ts observe one\apps\catchall --workspace one --policy strict --json
```

`--workspace one` 很重要：它决定 `.kiln/data/` 落在一键包内，与 MCP 服务保持一致。

## 4. 状态面板

```cmd
node one\kiln-up.mjs --panel --port 4311
```

浏览器打开 `http://127.0.0.1:4311/`。可查看连接状态、权限清单、最近自检，并一键「重新授权 / 撤销授权 / 重连 / 断开连接 / 重新自检」。面板只监听 `127.0.0.1`，带非本机 `Origin` 的请求返回 `403`；不要把它改成 `0.0.0.0`。

## 5. 断开、撤销与重连

| 动作     | 命令                                             | 效果                                            |
| -------- | ------------------------------------------------ | ----------------------------------------------- |
| 断开     | `kiln down one` 或 `node one/kiln-up.mjs --down` | 移除自己注册的 server、清理自启项；**保留授权** |
| 撤销授权 | `kiln permissions one --action revoke`           | 状态变 `revoked`，此后 `kiln up` 会拒绝启动     |
| 重新授权 | `kiln permissions one --action grant` 或面板按钮 | 状态变 `granted`                                |
| 重连     | `kiln up one`（幂等）                            | 重新注册并自检，不重复备份                      |

写入用户客户端配置前会留 `<file>.kiln-one.bak`。`down` 只删除 `mcpServers.kiln-one` 这一个键，不会整体恢复备份，以免抹掉用户后续新增的配置。

## 6. 升级、备份与迁移

- **备份 / 迁移**：复制整个 `one/` 目录即可。数据、状态、可导入配置都在包内。
- **修改源码后必须重新 seal**：任何对 `AGENT.md`、`up.json`、`README.md`、`kiln-up.*`、`apps/**` 的改动都要执行 `kiln seal one`，否则 `up` 会被 `KILN_ONE_INTEGRITY` 拦下。`.kiln/`、`.mcp.json`、`checksums.json` 自身不参与 seal。
- **升级应用**：替换 `apps/` 下文件 → `kiln check one/apps/<cast>` → `kiln seal one` → `kiln up one`。
- **版本兼容**：`up.json` 与 `checksums.json` 都是 `schemaVersion: 1`；状态文件版本不匹配时明确报 `KILN_ONE_STATE`，不静默迁移。
- **换机器**：`one/.mcp.json` 里的 `command` / `args` 含绝对路径，换机器后重跑 `kiln up` 即可重写。

## 7. 新增应用（维护者）

1. 在 `one/apps/<id>/` 放 `cast.json` 与 `src/pact.ts`，沿用四动词契约（见 [PACT.md](./PACT.md)）。
2. `grants` 只申请必需能力；面向普通用户的应用默认不申请 `net` / `shell`。
3. `kiln check one/apps/<id>` 通过（每个工具必须有真实 `call` + `result` 示例）。
4. `kiln seal one`，再 `kiln up one` 自检。
5. 若新增自检工具，更新 `up.json` 的 `handshake.probeTool` / `describeTool` 后重新 seal。

不要把业务逻辑写进插件：插件机制只用于新的 agent 协议、能力类型、校验规则与横切关注点。

## 8. 故障排查

| 现象 / 错误码            | 原因                                         | 处理                                                                           |
| ------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------ |
| `KILN_ONE_RUNTIME`       | Node 过低或找不到内核                        | 升级到 ≥22.18；设置 `KILN_HOME`                                                |
| `KILN_ONE_INTEGRITY`     | 包被改动或多了未登记文件                     | 确认改动来自自己后 `kiln seal one`；否则换回原始包                             |
| `KILN_ONE_APPROVAL`      | 授权已撤销                                   | `kiln permissions one --action grant`                                          |
| `KILN_ONE_CLIENT`        | 客户端配置 JSON 损坏或 `mcpServers` 不是对象 | 备份后修复该配置；Kiln 不会覆盖它                                              |
| `KILN_ONE_HANDSHAKE`     | 契约或工具名有问题                           | `kiln check one/apps/catchall`；必要时手动 `kiln mcp one/apps --policy strict` |
| `KILN_ONE_STATE`         | 状态文件损坏                                 | 备份删除 `one/.kiln/state/one-state.json` 后重跑 `up`                          |
| `KILN_ONE_AUTOSTART`     | 启动目录不可写                               | 检查权限或用 `KILN_ONE_AUTOSTART_DIR`                                          |
| `KILN_ONE_USAGE`         | 命令或面板请求参数错误                       | `kiln --help` 查看用法                                                         |
| `KILN_PROJECT_NOT_FOUND` | 找不到 cast 或面板路由                       | 检查 Studio 根目录与请求路径                                                   |
| `KILN_CAP_DENIED`        | 应用申请了策略不允许的能力                   | 检查 `cast.json` 的 `grants` 与 `policy`                                       |
| agent 看不到工具         | 客户端未重新加载 MCP 配置                    | 重启客户端；或导入 `one/.mcp.json`                                             |
| 数据「不见了」           | 调用时没带 `--workspace <bundle>`            | MCP 配置已带该参数；手工 CLI 调用需显式指定                                    |

## 9. 维护要点

- **每次改动后的门禁（开发仓库）**：`npm test`（96 个用例）、`npm run typecheck`、`npm run format:check`、`npm run bench:one`、`kiln seal one` + `kiln up one --json`。
- **运行时零依赖**是硬约束：`packages/one` 与 `one/apps` 只能 import Node 内置模块和仓库内 `#*` 映射。
- **性能预算**：`observe ≤ 2048 B`；`find` 返回 `≤ 10` 条；`export_list` 单批 `≤ 500` 条；`clear-done` 单批 `≤ 200` 条；台账上限 `10,000` 条。
- **可观测性**：就绪报告含 `handshake.ms`、`tools`、`integrity.files`；`status` 含 `lastCheck` 与连接清单；面板可随时重新自检。
- **完整性清单不是签名**：sha256 只能发现「与 seal 时不一致」，证明不了发布者身份；分发给他人时应另附可信渠道的校验值（详见 [安全策略](../SECURITY.md)）。
- **安全边界**：`SECURITY.md` 的所有限制仍然成立——默认执行仍在宿主进程内，能力网关是逻辑边界而非 OS 边界；融合层提供 `--isolated` 进程级隔离、签名与审计。默认只跑已 seal 的可信内置应用。

## 10. 已知限制

1. 一键包只生成 stdio 配置；HTTP / SSE 端点由融合层 `kiln mcp-http` 提供，远程使用需自行配置令牌与网络边界。
2. `one/.mcp.json` 与客户端配置含本机绝对路径，换机器要重跑 `up`。客户端自动探测覆盖 Claude Desktop、Cursor 与包内 `.mcp.json`；其它客户端用 `KILN_ONE_CLIENT_CONFIG` 指定或手动导入。
3. 开机自启默认关闭；启用后只是开机重跑一次幂等的 `up`，不是常驻后台服务。
4. 持久化是单文件 KV，每次写入重写整份 `store.json`（O(n)）；跨进程并发写仍是 last-write-wins，索引会在下次读取时自愈。
5. 发现层是字符 n-gram 向量 + 关键词混合检索，不是神经 embedding；同义词与跨语言查询仍有限。
6. 宿主生命周期、多租户隔离、`service` 型入口与 `model` / `agent` 离线驱动已由融合层补齐，见 [融合层说明](./FUSION.md)；仍缺应用市场服务端、计量结算与真实上游客户端界面的人工端到端验收。
