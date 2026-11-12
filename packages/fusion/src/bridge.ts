import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { discoverCastDirs, loadCast, buildMcpTools, type CastCatalog } from "#pact";
import { CastRunner, STRICT_POLICY } from "#host";
import { KilnError } from "#grain";

/* ——— 发现层与多租户 ——— */

export interface DiscoveryEntry {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly intents: readonly string[];
  readonly dir: string;
}

export interface DiscoveryIndex {
  readonly schemaVersion: 1;
  readonly entries: readonly DiscoveryEntry[];
}

export async function buildDiscovery(castDirs: readonly string[]): Promise<DiscoveryIndex> {
  const entries: DiscoveryEntry[] = [];
  for (const dir of castDirs) {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, "cast.json"), "utf8")) as Record<string, unknown>;
      entries.push({
        id: String(raw.id ?? ""),
        title: String(raw.title ?? ""),
        summary: String(raw.summary ?? ""),
        intents: Array.isArray(raw.intents) ? raw.intents.map(String) : [],
        dir,
      });
    } catch {
      /* 损坏目录跳过，由发现层报告可用性 */
    }
  }
  return { schemaVersion: 1, entries };
}

export function searchDiscovery(index: DiscoveryIndex, query: string): { entry: DiscoveryEntry; score: number }[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return index.entries
    .map((entry) => {
      const haystack = `${entry.id} ${entry.title} ${entry.summary} ${entry.intents.join(" ")}`.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 3 : 0), 0);
      return { entry, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** 每个租户独立数据目录，避免跨租户读写。 */
export function tenantPaths(
  workspace: string,
  tenant = "default",
  castId = "app",
): { dataDir: string; workspace: string } {
  const root = path.resolve(workspace);
  return { dataDir: path.join(root, ".kiln", "tenants", tenant, "data", castId), workspace: root };
}

/* ——— model / agent 可插拔驱动（默认离线，不联网） ——— */

export interface ModelHandler {
  (prompt: string, options: Record<string, unknown>): Promise<unknown>;
}

export interface AgentHandler {
  (task: string, maxTurns: number): Promise<unknown>;
}

export function createModelDriver(handler?: ModelHandler): {
  readonly id: "model";
  accepts(grant: unknown): boolean;
  open(grant: unknown): unknown;
} {
  return {
    id: "model",
    accepts: (grant) => grant !== null && typeof grant === "object",
    open: () => ({
      complete: async (prompt: string, options: Record<string, unknown> = {}) =>
        handler
          ? await handler(prompt, options)
          : { ok: false, reason: "未配置模型处理器，默认离线驱动不发起外部调用" },
    }),
  };
}

export function createAgentDriver(handler?: AgentHandler): {
  readonly id: "agent";
  accepts(grant: unknown): boolean;
  open(grant: unknown): unknown;
} {
  return {
    id: "agent",
    accepts: (grant) => grant !== null && typeof grant === "object",
    open: (grant) => {
      const limit = Math.min(
        8,
        typeof (grant as { maxTurns?: unknown }).maxTurns === "number"
          ? (grant as { maxTurns: number }).maxTurns || 1
          : 1,
      );
      return {
        run: async (task: string) =>
          handler
            ? await handler(task, limit)
            : { ok: false, reason: "未配置 agent 处理器，默认离线驱动不发起外部调用", maxTurns: limit },
      };
    },
  };
}

/* ——— HTTP / SSE MCP 端点 ——— */

interface HttpCast {
  readonly catalog: CastCatalog;
  readonly runner: CastRunner;
}

export interface McpHttpOptions {
  readonly castsDir: string;
  readonly port?: number;
  readonly host?: string;
  readonly token?: string;
  readonly tenant?: string;
  readonly policy?: "strict" | "local" | "relaxed";
}

export interface McpHttpServer {
  readonly url: string;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new KilnError({ code: "KILN_FUSION_HTTP", message: "请求体过大" });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function prepare(options: McpHttpOptions): Promise<HttpCast[]> {
  const dirs = await discoverCastDirs(options.castsDir, 4);
  const casts: HttpCast[] = [];
  for (const dir of dirs) {
    const loaded = await loadCast({ dir });
    if (!loaded.ok) continue;
    const paths = tenantPaths(options.castsDir, options.tenant, loaded.cast.manifest.id);
    casts.push({
      catalog: loaded.cast.catalog,
      runner: new CastRunner({
        cast: loaded.cast,
        policy:
          options.policy === "local" || options.policy === "relaxed"
            ? { default: "allow", capabilities: {}, onAsk: "allow" }
            : STRICT_POLICY,
        paths,
      }),
    });
  }
  return casts;
}

async function callTool(casts: readonly HttpCast[], name: string, args: Record<string, unknown>): Promise<unknown> {
  for (const { catalog, runner } of casts) {
    const prefix = `${catalog.castId}__`;
    if (!name.startsWith(prefix)) continue;
    if (name === `${prefix}describe`) return await runner.describe();
    if (name === `${prefix}observe`) return (await runner.observe()).observation;
    if (name.startsWith(`${prefix}invoke__`))
      return (await runner.invoke(name.slice(`${prefix}invoke__`.length), args)).value;
    if (name.startsWith(`${prefix}act__`))
      return (await runner.act({ ...args, type: name.slice(`${prefix}act__`.length) })).outcome;
  }
  throw new KilnError({ code: "KILN_FUSION_HTTP", message: `未声明的 MCP 工具：${name}` });
}

export async function startMcpHttp(options: McpHttpOptions): Promise<McpHttpServer> {
  const casts = await prepare(options);
  const host = options.host ?? "127.0.0.1";
  const sockets = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    try {
      if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
        return sendJson(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "未授权" } });
      }
      const route = new URL(req.url ?? "/", `http://${host}`).pathname;
      if (route === "/health" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          tools: casts.reduce((sum, item) => sum + buildMcpTools(item.catalog).length, 0),
          tenant: options.tenant ?? "default",
        });
      }
      if (route === "/sse" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `event: ready\ndata: ${JSON.stringify({ tools: casts.reduce((sum, item) => sum + buildMcpTools(item.catalog).length, 0) })}\n\n`,
        );
        sockets.add(res);
        const timer = setInterval(() => res.write(": heartbeat\n\n"), 5000);
        req.once("close", () => {
          clearInterval(timer);
          sockets.delete(res);
        });
        return;
      }
      if (route !== "/mcp" || req.method !== "POST") {
        return sendJson(res, 404, { jsonrpc: "2.0", id: null, error: { code: -32601, message: "未找到路由" } });
      }
      const message = JSON.parse(await readBody(req)) as {
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
      };
      const id = message.id ?? null;
      const reply = (result: unknown) => sendJson(res, 200, { jsonrpc: "2.0", id, result });
      if (message.method === "initialize") {
        return reply({
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "kiln-http", version: "0.2.0" },
        });
      }
      if (message.method === "ping") return reply({});
      if (message.method === "tools/list") {
        return reply({ tools: casts.flatMap((item) => buildMcpTools(item.catalog)) });
      }
      if (message.method === "tools/call") {
        const params = message.params ?? {};
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          const value = await callTool(casts, String(params.name ?? ""), args);
          return reply({
            content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
            isError: false,
          });
        } catch (error) {
          const issue = (error as { issue?: unknown }).issue ?? { code: "KILN_CALL_FAILED", message: String(error) };
          return reply({ content: [{ type: "text", text: JSON.stringify(issue) }], isError: true });
        }
      }
      return sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "不支持的方法" } });
    } catch (error) {
      return sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: (error as Error).message },
      });
    }
  });
  const port = options.port ?? 4312;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://${host}:${actual}`,
    close: () => {
      for (const socket of sockets) socket.end();
      return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
