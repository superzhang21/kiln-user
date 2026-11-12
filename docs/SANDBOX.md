# 受限执行容器（沙箱）

> 目标：让一个会死循环、会吃内存、会主动越权的 cast 无法拖垮宿主，也无法悄悄拿到不该拿的能力。

## 1. 为什么需要

能力网关能拦住 `ctx.cap` 的越权调用，但拦不住 cast 直接 `import("node:fs")`、写 `while (true) {}` 或一次分配几百 MB。默认同进程执行时，这些问题会直接拖垮宿主。沙箱把执行挪到独立线程，并给内存与时间设硬上限。

## 2. 架构

```
主线程（宿主）
  ├─ 组装 SandboxOptions（目录、动词、参数、策略、配额）
  ├─ new Worker(..., { resourceLimits })
  ├─ setTimeout(timeout) → worker.terminate()
  └─ 只接收 { ok, value, ms } 或结构化 issue
        │
        ▼
Worker 线程（受限执行）
  ├─ loadCast（同一套清单校验）
  ├─ CastRunner（同一套能力网关与授权）
  └─ 执行 invoke / observe / act / describe
```

- **内存**：`resourceLimits.maxOldGenerationSizeMb` 限制 V8 堆；超限时 Worker 以 OOM 退出，主线程收到结构化错误。
- **时间**：主线程计时，超时直接 `terminate()`，返回 `KILN_SANDBOX_TIMEOUT`；死循环不会阻塞宿主事件循环。
- **崩溃隔离**：Worker 内未捕获异常/提前退出返回 `KILN_SANDBOX_CRASH`，宿主继续服务。
- **能力边界**：授权仍在 `CastRunner` / 能力网关内判定，沙箱不放宽任何权限。

## 3. 用法

```bash
# 单次调用
kiln invoke examples/ledger seed --args '{"rows":8}' --sandbox --json

# 显式沙箱命令（可调配额）
kiln sandbox examples/ledger seed --args '{"rows":8}' --timeout 3000 --memory 64 --json
```

| 参数        | 默认    | 说明                    |
| ----------- | ------- | ----------------------- |
| `--timeout` | 5000 ms | 超过即终止，最小 100 ms |
| `--memory`  | 128 MB  | V8 堆上限，最小 32 MB   |

输出中的 `sandbox` 字段包含 `threadId`、`memoryMb`、`ms`、`code`，便于评测与排障。

## 4. 边界（必须如实说明）

1. **Worker 不是 OS 沙箱**。它隔离堆内存与事件循环，但共享进程的权限。cast 若主动 `import("node:fs")`，仍可能绕过能力网关直接读写文件。
2. **需要更强隔离时**用子进程 + Node 权限模型：`kiln invoke ... --isolated --hardened`。运行时不支持 `--permission` 时会自动回退为普通子进程隔离，并在结果中标注 `hardened: false`。
3. **Buffer 等外部内存不受 V8 堆上限约束**，极端情况下仍可能耗尽系统内存；生产环境应叠加容器内存限制。
4. **不要运行完全不可信的第三方代码**，除非已启用容器或系统级隔离。

## 5. 验证

`test/sandbox.spec.ts` 覆盖：

- 正常 cast 在独立线程返回结果（`threadId` 有效）；
- 死循环在 400 ms 内被终止，宿主继续运行；
- 分配大对象触发内存上限，返回沙箱错误而不是宿主崩溃。

## 6. 与「进程隔离」的关系

| 模式                    | 实现                    | 防死循环        | 防内存爆炸  | 防主动越权             |
| ----------------------- | ----------------------- | --------------- | ----------- | ---------------------- |
| 默认                    | 同进程                  | 否              | 否          | 仅能力网关             |
| `--sandbox`             | Worker + resourceLimits | 是              | 是（V8 堆） | 仍否                   |
| `--isolated`            | 子进程                  | 是（超时 kill） | 部分        | 仍否                   |
| `--isolated --hardened` | 子进程 + 权限模型       | 是              | 部分        | 较好，取决于运行时支持 |

选择建议：日常内置应用用默认或 `--sandbox`；导入的第三方包至少 `--sandbox`；完全不可信代码必须容器 + `--hardened`。
