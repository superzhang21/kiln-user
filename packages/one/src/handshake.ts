import { spawn } from "node:child_process";
import path from "node:path";
import { KilnError } from "#grain";
import { cliPath } from "./bundle.ts";
import type { HandshakeResult, UpConfig } from "./types.ts";

interface RpcMessage {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

interface HandshakeOptions {
  readonly bundleDir: string;
  readonly config: UpConfig;
  readonly runtimeRoot: string;
  readonly timeoutMs?: number;
}

function resultOf(messages: Map<number, RpcMessage>, stderr: string, started: number): HandshakeResult {
  const base = { at: new Date().toISOString(), ms: Date.now() - started };
  const fail = (error: string): HandshakeResult => ({ ok: false, ...base, error });
  const initialize = messages.get(1);
  const listed = messages.get(2);
  const described = messages.get(3);
  const probed = messages.get(4);
  if (!initialize || !listed || !described || !probed) {
    return fail(`握手响应不完整（收到 ${messages.size}/4 条）${stderr ? `；stderr: ${stderr.slice(0, 300)}` : ""}`);
  }
  if (initialize.error || !initialize.result) return fail(`initialize 失败: ${initialize.error?.message ?? "无结果"}`);
  const protocolVersion = initialize.result.protocolVersion;
  if (typeof protocolVersion !== "string") return fail("initialize 未返回协议版本");

  const tools = listed.result?.tools;
  if (listed.error || !Array.isArray(tools) || tools.length === 0) {
    return fail(`tools/list 失败或工具表为空: ${listed.error?.message ?? "无工具"}`);
  }
  for (const [label, message] of [
    ["describe", described],
    ["probe", probed],
  ] as const) {
    if (message.error || !message.result || message.result.isError !== false) {
      return fail(`${label} 调用失败: ${message.error?.message ?? JSON.stringify(message.result ?? {}).slice(0, 200)}`);
    }
  }
  return {
    ok: true,
    ...base,
    protocolVersion,
    tools: tools.length,
    describeOk: true,
    probeOk: true,
  };
}

/** 自检必须走真实 stdio 服务：mock 出来的握手不代表客户端连得上。 */
export async function runHandshake(options: HandshakeOptions): Promise<HandshakeResult> {
  const timeoutMs = options.timeoutMs ?? options.config.handshake.timeoutMs;
  const started = Date.now();
  const { config } = options;
  const child = spawn(
    process.execPath,
    [
      cliPath(options.runtimeRoot),
      "mcp",
      path.join(options.bundleDir, config.appsDir),
      "--policy",
      config.policy,
      "--workspace",
      options.bundleDir,
    ],
    { stdio: ["pipe", "pipe", "pipe"], cwd: options.runtimeRoot, windowsHide: true },
  );

  return await new Promise<HandshakeResult>((resolve) => {
    const messages = new Map<number, RpcMessage>();
    let buffer = "";
    let stderr = "";
    let settled = false;

    const finish = (result: HandshakeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        /* 子进程可能已退出 */
      }
      if (!child.killed) child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, at: new Date().toISOString(), ms: Date.now() - started, error: `握手超时 ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (line === "") continue;
        try {
          const parsed = JSON.parse(line) as RpcMessage;
          if (typeof parsed.id === "number") messages.set(parsed.id, parsed);
        } catch {
          /* 非协议行忽略，诊断信息保留在错误输出中 */
        }
      }
      if (messages.size >= 4) finish(resultOf(messages, stderr, started));
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.once("error", (error) => {
      finish({
        ok: false,
        at: new Date().toISOString(),
        ms: Date.now() - started,
        error: `MCP 服务启动失败: ${error.message}`,
      });
    });
    child.once("close", () => {
      if (!settled) finish(resultOf(messages, stderr, started));
    });

    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: config.handshake.protocolVersion,
          capabilities: {},
          clientInfo: { name: "kiln-one", version: config.version },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: config.handshake.describeTool, arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: config.handshake.probeTool, arguments: {} } },
    ];
    try {
      for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    } catch (error) {
      finish({
        ok: false,
        at: new Date().toISOString(),
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export function assertHandshake(result: HandshakeResult): void {
  if (result.ok) return;
  throw new KilnError({
    code: "KILN_ONE_HANDSHAKE",
    message: `agent 自检未通过: ${result.error ?? "未知原因"}`,
    hint: "运行 `kiln check <bundle>/apps/<cast>` 看契约问题，或 `kiln mcp <bundle>/apps --policy strict` 手动复现；修复后重跑 `kiln up`。",
    detail: { handshake: result },
  });
}
