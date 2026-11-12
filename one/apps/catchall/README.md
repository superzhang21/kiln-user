# 随手收（catchall）

Kiln One 开箱自带的默认应用：本地优先、agent 原生的日常事务台账。

- `capture` 收纳一条内容，自动去重、自动分类（todo / link / bill / note / idea）。
- `find` 在精简索引上检索，只对最终命中的少量记录读全文，返回片段而不是整库。
- `digest` 生成日/周摘要；`observe` 返回预算内的今日状态；`act` 一轮推进并直接回新状态。
- `export_list` 把台账导出成 `{castdata}/exports/` 下的 Markdown 或 JSON。
- 索引只是读加速缓存：条目数与 `item:*` 不一致时会从记录本身重建，并发写或损坏不会丢数据。

权限只申请 `store` 与 `{castdata}` 下的 `file`，不联网、不执行命令，因此可以直接跑在 `strict` 策略下。

工具参数、返回值与示例见 `cast.json`；接口说明见 `docs/ONE-API.md`。
