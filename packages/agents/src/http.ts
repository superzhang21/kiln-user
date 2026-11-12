import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { KilnError, toIssue } from "#grain";
import type { AgentBridge } from "./index.ts";

/**
 * 通用 HTTP 网关。
 *
 * 这是「任意 agent、任意语言、任意运行环境」的兜底通道：
 * 只要能发 HTTP，就能列出工具并调用，不需要装 SDK、不需要懂 MCP。
 *
 * 默认只监听 127.0.0.1。三道闸门依次是：
 *   1. Bearer token（可选）——谁能进来；
 *   2. 固定窗口限流（默认 120 次/分钟）——进来后能刷多快；
 *   3. 并发上限（默认 4）与单次超时（默认 120s）——同时能干几件、干多久。
 * 任何一道拦下都返回结构化 error，而不是让调用方对着状态码猜。
 */

export interface HttpBridgeOptions {
  readonly bridge: AgentBridge;
  readonly port?: number;
  readonly host?: string;
  readonly token?: string;
  /** 每分钟允许的请求数（进程级固定窗口），0 表示不限。默认 120。 */
  readonly rateLimitPerMinute?: number;
  /** 同时在跑的调用上限，超出的立刻拒绝而不是排队。默认 4。 */
  readonly maxConcurrent?: number;
  /** 单次工具调用超时（毫秒），0 表示不限。默认 120000。 */
  readonly callTimeoutMs?: number;
  /** 注入时钟，测试用。 */
  readonly now?: () => number;
}

export interface HttpBridgeHandle {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly limits: {
    readonly rateLimitPerMinute: number;
    readonly maxConcurrent: number;
    readonly callTimeoutMs: number;
  };
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 120;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 120_000;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new KilnError({ code: "KILN_AGENT_HTTP", message: `请求体超过 ${MAX_BODY_BYTES} 字节上限` });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (text.trim() === "") return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function setCors(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
}

export async function serveHttpBridge(options: HttpBridgeOptions): Promise<HttpBridgeHandle> {
  const host = options.host ?? "127.0.0.1";
  const bridge = options.bridge;
  const token = options.token;
  const rateLimit = options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_CONCURRENCY;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  let windowStart = now();
  let windowCount = 0;
  let inflight = 0;

  const rateState = (): { allowed: boolean; remaining: number; retryAfter: number } => {
    if (rateLimit <= 0) return { allowed: true, remaining: -1, retryAfter: 0 };
    const current = now();
    if (current - windowStart >= WINDOW_MS) {
      windowStart = current;
      windowCount = 0;
    }
    const retryAfter = Math.max(1, Math.ceil((windowStart + WINDOW_MS - current) / 1000));
    if (windowCount >= rateLimit) return { allowed: false, remaining: 0, retryAfter };
    windowCount += 1;
    return { allowed: true, remaining: Math.max(0, rateLimit - windowCount), retryAfter };
  };

  const send = (response: ServerResponse, status: number, payload: unknown): void => {
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    setCors(response);
    response.end(JSON.stringify(payload));
  };

  const reject = (
    response: ServerResponse,
    status: number,
    message: string,
    extra: Record<string, unknown> = {},
  ): void => {
    send(response, status, {
      ok: false,
      error: { code: "KILN_AGENT_HTTP", message, hint: "见 docs/AGENTS.md 的 HTTP 网关一节。", ...extra },
    });
  };

  const callWithTimeout = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (callTimeoutMs <= 0) return bridge.callTool(name, args);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        bridge.callTool(name, args),
        new Promise<never>((_, rejectCall) => {
          timer = setTimeout(() => {
            rejectCall(
              new KilnError({
                code: "KILN_AGENT_HTTP",
                message: `工具调用超时（>${callTimeoutMs}ms）: ${name}`,
                hint: "工具本身太慢，或死循环。可加大 --timeout，或先修工具。",
              }),
            );
          }, callTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      setCors(response);
      response.end();
      return;
    }
    if (token) {
      const header = request.headers.authorization ?? "";
      if (header !== `Bearer ${token}`) {
        send(response, 401, {
          ok: false,
          error: { code: "KILN_AGENT_HTTP", message: "缺少或错误的 Bearer token" },
        });
        return;
      }
    }

    const gate = rateState();
    if (rateLimit > 0) {
      response.setHeader("x-ratelimit-limit", String(rateLimit));
      response.setHeader("x-ratelimit-remaining", String(gate.remaining));
      response.setHeader("x-ratelimit-reset", String(gate.retryAfter));
    }
    if (!gate.allowed) {
      response.setHeader("retry-after", String(gate.retryAfter));
      reject(response, 429, `请求过于频繁：上限 ${rateLimit} 次/分钟`, { retryAfter: gate.retryAfter });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${host}`);
    const route = `${request.method ?? "GET"} ${url.pathname}`;

    if (route === "GET /health") {
      const tools = await bridge.listTools();
      send(response, 200, {
        ok: true,
        server: bridge.id,
        tools: tools.length,
        inflight,
        limits: { rateLimitPerMinute: rateLimit, maxConcurrent, callTimeoutMs },
        remaining: gate.remaining,
      });
      return;
    }

    if (route === "GET /describe" || route === "GET /tools/list" || route === "POST /tools/list") {
      const tools = await bridge.listTools();
      send(response, 200, { ok: true, protocol: "kiln.agent/1", server: bridge.id, tools });
      return;
    }

    if (route === "POST /tools/call") {
      const body = parseJsonObject(await readBody(request));
      if (!body) {
        reject(response, 400, "请求体必须是 JSON 对象");
        return;
      }
      const name = body.name;
      if (typeof name !== "string" || name === "") {
        reject(response, 400, "缺少工具名 name");
        return;
      }
      const args = body.arguments === undefined ? {} : body.arguments;
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        reject(response, 400, "arguments 必须是 JSON 对象");
        return;
      }
      if (inflight >= maxConcurrent) {
        reject(response, 429, `并发已满：上限 ${maxConcurrent} 个同时调用`, { inflight });
        return;
      }
      inflight += 1;
      try {
        const result = await callWithTimeout(name, args as Record<string, unknown>);
        send(response, 200, { ok: true, result });
      } catch (error) {
        // 业务失败也走 200 + ok:false：让 agent 拿到结构化 error，而不是靠 HTTP 状态码猜。
        // 网关自身的拒绝（超时/限额）带 status 语义，由上面几个分支直接返回非 200。
        const issue = toIssue(error);
        const status = issue.code === "KILN_AGENT_HTTP" && String(issue.message).includes("超时") ? 504 : 200;
        send(response, status, { ok: false, error: issue });
      } finally {
        inflight -= 1;
      }
      return;
    }

    reject(response, 404, `未知路由: ${route}`);
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      try {
        send(response, 500, { ok: false, error: toIssue(error) });
      } catch {
        /* 响应已结束，忽略 */
      }
    });
  });

  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? 0, host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? (address as AddressInfo).port : (options.port ?? 0);

  return {
    url: `http://${host}:${port}/`,
    host,
    port,
    limits: { rateLimitPerMinute: rateLimit, maxConcurrent, callTimeoutMs },
    close: () =>
      new Promise<void>((resolve, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolve()));
      }),
  };
}
