# Kiln One · 随手收

一个不用配置、不用注册、不用联网的日常小工具箱。把你随手丢给 AI 的内容留在本机，随时找得回来。

## 三步开始

1. **把这个文件夹交给你的 agent**（拖进对话即可），或双击 `kiln-up.cmd`（Windows）/ 运行 `./kiln-up.sh`（macOS、Linux）。
2. agent 会自动完成连接、权限确认和自检，然后告诉你「可以用了」。全程不需要你写配置、装依赖或记命令。
3. 直接说人话：

   > 把这段地址存一下
   > 帮我找上个月的房租发票
   > 今天要做什么
   > 这周汇总一下，导出成文件

## 你的数据

- 只在这台电脑：`.kiln/data/catchall/store.json`（相对本文件夹）。没有账号、没有云、没有密钥。
- 备份或换电脑：复制整个 `one/` 文件夹即可。
- 权限：只读写自己的数据目录，**不联网、不执行系统命令**。
- 随时断开：运行 `node kiln-up.mjs --down`，或用 `kiln permissions one --action revoke` 撤销授权。

## 想看状态

运行 `node kiln-up.mjs --panel`，浏览器打开 `http://127.0.0.1:4311/`。可以一键撤销授权、断开、重连、重新自检。

## 给维护者

- 修改 `apps/` 下任何文件后必须重新运行 `kiln seal one`，否则启动会被完整性校验拦下。
- 完整说明见仓库 `docs/ONE.md`、`docs/ONE-API.md`、`docs/ONE-OPS.md`。
- 给 agent 读的机器可读说明在 `AGENT.md`，不要删除。
