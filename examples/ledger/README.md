# 事件账本摘要（ledger）

task 型 cast 的参考实现：无状态调用，把大对象压成小结果。

```bash
node ../../packages/surface/src/cli.ts invoke . seed --args '{"rows":800}' --json
node ../../packages/surface/src/cli.ts invoke . digest --args '{"file":"events.ndjson"}' --json
```

## 它演示什么

一次真实压缩，数字当场算出来，不是文档里的比喻：

```
bytes: 65440  →  summaryBytes: 109  →  ratio: 0.0017
```

65 KB 的 NDJSON 进去，109 字节的摘要出来。agent 拿到的是摘要，不是全文。

## 清单要点

```jsonc
"shape": "task",
"verbs": ["describe", "invoke"],
"grants": { "file": { "read": ["{castdata}"], "write": ["{castdata}"] } }
```

`{castdata}` 指向 `.kiln/data/ledger/`，只读写这个目录。想读别处会被网关拦下——并且 cast 无法把这次拦截 catch 成普通返回值。

## 试着越界

```bash
node ../../packages/surface/src/cli.ts invoke . digest --args '{"file":"{workspace}/package.json"}'
```

返回 `KILN_CAP_DENIED`：`grants.file.read` 只覆盖 `{castdata}`，没覆盖 `{workspace}`。

即使 `digest` 内部对读文件做了 try/catch 并返回 `{ ok: false }`，网关的记账也会在动词返回后把这次拒绝重新抛出。**业务错误可以被吞，越权不行。**
