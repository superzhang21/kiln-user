import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { KilnError, toIssue } from "#grain";
import type { CastCatalog } from "#pact";
import { buildMcpTools } from "#pact";
import type { CastRunner } from "#host";

const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", LATEST_PROTOCOL_VERSION]);

type RequestId = string | number;

interface McpRequest {
  readonly jsonrpc: "2.0";
  readonly id: RequestId;
  readonly method: string;
  readonly params?: unknown;
}

interface McpContext {
  readonly casts: ReadonlyMap<string, McpCast>;
  initializationResponded: boolean;
  initialized: boolean;
}

export interface McpCast {
  readonly runner: CastRunner;
  readonly catalog: CastCatalog;
}

export interface McpServerOptions {
  readonly casts: readonly McpCast[];
  readonly input?: Readable;
  readonly output?: Writable;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function response(id: RequestId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: RequestId | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolError(error: unknown) {
  const issue = toIssue(error);
  return {
    content: [{ type: "text", text: JSON.stringify(issue) }],
    isError: true,
  };
}

function toolText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

async function callTool(context: McpContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  const cast = [...context.casts.values()].find(({ catalog }) => name.startsWith(`${catalog.castId}__`));
  if (!cast) {
    throw new KilnError({
      code: "KILN_PACT_MISMATCH",
      message: `MCP 工具未声明: ${name}`,
      detail: { tool: name },
    });
  }
  const { catalog, runner } = cast;
  const castPrefix = `${catalog.castId}__`;

  if (name === `${castPrefix}describe`) return await runner.describe();
  if (name === `${castPrefix}observe`) return (await runner.observe()).observation;

  const invokePrefix = `${castPrefix}invoke__`;
  if (name.startsWith(invokePrefix)) {
    return (await runner.invoke(name.slice(invokePrefix.length), args)).value;
  }

  const actPrefix = `${castPrefix}act__`;
  if (name.startsWith(actPrefix)) {
    return (await runner.act({ ...args, type: name.slice(actPrefix.length) })).outcome;
  }

  throw new KilnError({
    code: "KILN_PACT_MISMATCH",
    message: `MCP 工具未声明: ${name}`,
    detail: { cast: catalog.castId, tool: name },
  });
}

async function handleRequest(message: unknown, context: McpContext): Promise<unknown | null> {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(null, -32600, "Invalid Request");
  }

  const hasId = Object.hasOwn(message, "id");
  if (!hasId) {
    if (message.method === "notifications/initialized" && context.initializationResponded) {
      context.initialized = true;
    }
    return null;
  }

  if (!isRequestId(message.id)) return rpcError(null, -32600, "Invalid Request");
  const request: McpRequest = {
    jsonrpc: "2.0",
    id: message.id,
    method: message.method,
    ...(message.params !== undefined ? { params: message.params } : {}),
  };

  if (request.method === "initialize") {
    const params = isRecord(request.params) ? request.params : {};
    const requestedVersion = params.protocolVersion;
    const protocolVersion =
      typeof requestedVersion === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : LATEST_PROTOCOL_VERSION;
    context.initializationResponded = true;
    return response(request.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "kiln", version: "0.1.0" },
    });
  }

  if (!context.initialized) return rpcError(request.id, -32002, "Server not initialized");
  if (request.method === "ping") return response(request.id, {});
  if (request.method === "tools/list") {
    const tools = [...context.casts.values()].flatMap(({ catalog }) => buildMcpTools(catalog));
    return response(request.id, { tools });
  }
  if (request.method === "tools/call") {
    const params = isRecord(request.params) ? request.params : {};
    if (typeof params.name !== "string") {
      return response(request.id, toolError(new KilnError({ code: "KILN_USAGE", message: "缺少 MCP 工具名" })));
    }
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isRecord(args)) {
      return response(
        request.id,
        toolError(new KilnError({ code: "KILN_USAGE", message: "MCP 工具 arguments 必须是 JSON 对象" })),
      );
    }
    try {
      const value = await callTool(context, params.name, args);
      return response(request.id, { content: [{ type: "text", text: toolText(value) }], isError: false });
    } catch (error) {
      return response(request.id, toolError(error));
    }
  }

  return rpcError(request.id, -32601, "Method not found");
}

async function writeMessage(output: Writable, message: unknown): Promise<void> {
  if (!output.write(`${JSON.stringify(message)}\n`)) await once(output, "drain");
}

export async function serveMcp(options: McpServerOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  // 客户端提前断开时 stdout 会 EPIPE；记到 stderr，不让未捕获异常打断服务退出。
  output.on("error", (error: NodeJS.ErrnoException) => {
    process.stderr.write(`[KILN_CALL_FAILED] MCP 输出流中断: ${error.code ?? error.message}\n`);
  });
  if (options.casts.length === 0) {
    throw new KilnError({ code: "KILN_ENTRY_MISSING", message: "没有可供 MCP 服务暴露的 cast" });
  }
  const casts = new Map<string, McpCast>();
  for (const cast of options.casts) {
    const id = cast.catalog.castId;
    if (casts.has(id)) {
      throw new KilnError({
        code: "KILN_MANIFEST_ID",
        message: `MCP 服务发现重复的 cast id: ${id}`,
        detail: { castId: id },
      });
    }
    casts.set(id, cast);
  }
  const context: McpContext = {
    casts,
    initializationResponded: false,
    initialized: false,
  };
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      await writeMessage(output, rpcError(null, -32700, "Parse error"));
      continue;
    }

    await writeMessageIfPresent(output, await handleRequest(message, context));
  }
}

async function writeMessageIfPresent(output: Writable, message: unknown | null): Promise<void> {
  if (message !== null) await writeMessage(output, message);
}
