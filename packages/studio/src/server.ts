import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toIssue, validateManifest, type Issue } from "#grain";
import { discoverCastDirs, loadCast, type LoadedCast } from "#pact";
import { CastRunner, LOCAL_POLICY, RELAXED_POLICY, STRICT_POLICY, createRegistry, type AuditRecord } from "#host";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..", "web");
const BRAND_ROOT = path.resolve(HERE, "..", "..", "..", "assets", "brand");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const CAPABILITIES = ["shell", "net", "store", "file", "model", "agent"] as const;

export interface StudioOptions {
  readonly root: string;
  readonly port?: number;
  readonly host?: string;
  /** 开发模式：按 mtime 重新加载 cast，默认开启（Studio 本身就是开发工具）。 */
  readonly dev?: boolean;
}

export interface Studio {
  readonly url: string;
  close(): Promise<void>;
}

type Registry = Awaited<ReturnType<typeof createRegistry>>;

interface Scanned {
  readonly casts: Map<string, LoadedCast>;
  readonly issues: Issue[];
}

function send(res: ServerResponse, status: number, body: string, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  send(res, status, JSON.stringify(payload, null, 2));
}

function sendIssues(res: ServerResponse, status: number, issues: readonly Issue[]) {
  sendJson(res, status, { ok: false, issues });
}

async function sendFile(res: ServerResponse, file: string) {
  try {
    const body = await readFile(file);
    send(res, 200, body.toString(), MIME[path.extname(file)] ?? "application/octet-stream");
  } catch {
    sendJson(res, 404, { ok: false, issues: [toIssue(new Error(`未找到资源：${file}`))] });
  }
}

function safeJoin(root: string, relative: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, `.${path.posix.normalize(`/${relative}`)}`);
  const fromRoot = path.relative(resolvedRoot, resolved);
  return fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot) ? null : resolved;
}

async function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new Error("请求体过大");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function policyFor(name: unknown) {
  if (name === "strict") return STRICT_POLICY;
  if (name === "relaxed") return RELAXED_POLICY;
  return LOCAL_POLICY;
}

/**
 * 目录指纹：把所有文件的 mtime 拼成一个字符串。
 * 不用 fs.watch：跨平台行为不一致，Windows 上会漏事件；轮询 stat 的代价是每 1.5 秒一次。
 */
async function walkMtime(dir: string, depth = 0): Promise<string> {
  if (depth > 2) return "";
  const parts: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) parts.push(await walkMtime(full, depth + 1));
    else {
      const info = await stat(full).catch(() => null);
      if (info) parts.push(`${full}:${info.mtimeMs}`);
    }
  }
  return parts.join("|");
}

/** 每次请求重扫：开发模式下改完 pact.ts 立即生效，不依赖进程重启。 */
async function scan(root: string, dev: boolean): Promise<Scanned> {
  const casts = new Map<string, LoadedCast>();
  const issues: Issue[] = [];
  for (const dir of await discoverCastDirs(root)) {
    const loaded = await loadCast({ dir, dev });
    if (loaded.ok) casts.set(loaded.cast.manifest.id, loaded.cast);
    else issues.push(...loaded.issues);
  }
  return { casts, issues };
}

export async function startStudio(options: StudioOptions): Promise<Studio> {
  const root = path.resolve(options.root);
  const dev = options.dev !== false;
  const registry: Registry = await createRegistry();
  const auditFile = path.join(root, ".kiln", "audit.jsonl");
  const timers = new Set<ReturnType<typeof setInterval>>();
  const streams = new Set<ServerResponse>();

  const audit = (record: AuditRecord) => {
    void (async () => {
      try {
        await mkdir(path.dirname(auditFile), { recursive: true });
        await appendFile(auditFile, `${JSON.stringify(record)}\n`, "utf8");
      } catch {
        /* 审计失败不影响界面 */
      }
    })();
  };

  const runnerFor = (cast: LoadedCast, policy: unknown) =>
    new CastRunner({
      cast,
      policy: policyFor(policy),
      paths: { dataDir: path.join(root, ".kiln", "data", cast.manifest.id), workspace: root },
      registry,
      audit,
    });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = url.pathname;

      if (route === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`event: ready\ndata: ${JSON.stringify({ root, dev })}\n\n`);
        streams.add(res);
        let last = await walkMtime(root);
        const timer = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(timer);
            timers.delete(timer);
            streams.delete(res);
            return;
          }
          void (async () => {
            const next = await walkMtime(root);
            if (next === last) return;
            last = next;
            // 连接可能在扫描期间被关闭，写入前再确认一次。
            if (res.writableEnded || res.destroyed) return;
            res.write(`event: refresh\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
          })();
        }, 1500);
        timers.add(timer);
        req.once("close", () => {
          clearInterval(timer);
          timers.delete(timer);
          streams.delete(res);
        });
        return;
      }

      if (route === "/api/casts" && req.method === "GET") {
        const { casts, issues } = await scan(root, dev);
        const list = [...casts.values()].map((cast) => ({
          id: cast.manifest.id,
          version: cast.manifest.version,
          title: cast.manifest.title,
          summary: cast.manifest.summary,
          shape: cast.manifest.shape,
          verbs: cast.manifest.verbs,
          intents: cast.manifest.intents,
          tools: cast.catalog.tools.length,
          actions: cast.catalog.actions.length,
          cost: cast.catalog.cost,
        }));
        return sendJson(res, 200, { ok: true, root, dev, casts: list, issues });
      }

      if (route === "/api/audit" && req.method === "GET") {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
        let events: AuditRecord[] = [];
        try {
          const text = await readFile(auditFile, "utf8");
          events = text
            .split("\n")
            .filter((line) => line.trim() !== "")
            .slice(-limit)
            .map((line) => JSON.parse(line) as AuditRecord)
            .reverse();
        } catch {
          events = [];
        }
        return sendJson(res, 200, { ok: true, events });
      }

      const detail = route.match(/^\/api\/casts\/([a-z0-9-]+)$/);
      if (detail && req.method === "GET") {
        const cast = (await scan(root, dev)).casts.get(detail[1] ?? "");
        if (!cast) return sendJson(res, 404, { ok: false, issues: [{ code: "KILN_PROJECT_NOT_FOUND" }] });
        return sendJson(res, 200, { ok: true, manifest: cast.manifest, catalog: cast.catalog });
      }

      const grantsRoute = route.match(/^\/api\/casts\/([a-z0-9-]+)\/grants$/);
      if (grantsRoute && req.method === "GET") {
        const cast = (await scan(root, dev)).casts.get(grantsRoute[1] ?? "");
        if (!cast) return sendJson(res, 404, { ok: false, issues: [{ code: "KILN_PROJECT_NOT_FOUND" }] });
        return sendJson(res, 200, { ok: true, grants: cast.manifest.grants ?? {}, capabilities: CAPABILITIES });
      }
      if (grantsRoute && req.method === "PUT") {
        const cast = (await scan(root, dev)).casts.get(grantsRoute[1] ?? "");
        if (!cast) return sendJson(res, 404, { ok: false, issues: [{ code: "KILN_PROJECT_NOT_FOUND" }] });
        const payload = JSON.parse((await readBody(req, 64 * 1024)) || "{}") as { grants?: unknown };
        const file = path.join(cast.dir, "cast.json");
        const before = await readFile(file, "utf8");
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(before) as Record<string, unknown>;
        } catch (error) {
          return sendIssues(res, 400, [toIssue(error)]);
        }
        const next = { ...raw, grants: payload.grants ?? {} };
        const checked = validateManifest(next, { file });
        if (!checked.manifest) return sendIssues(res, 400, checked.issues);
        await writeFile(`${file}.bak`, before, "utf8");
        await writeFile(file, `${JSON.stringify(checked.manifest, null, 2)}\n`, "utf8");
        return sendJson(res, 200, { ok: true, manifest: checked.manifest, backup: `${file}.bak` });
      }

      const run = route.match(/^\/api\/casts\/([a-z0-9-]+)\/run$/);
      if (run && req.method === "POST") {
        const payload = JSON.parse((await readBody(req)) || "{}") as {
          verb?: string;
          name?: string;
          args?: Record<string, unknown>;
          policy?: string;
        };
        const cast = (await scan(root, dev)).casts.get(run[1] ?? "");
        if (!cast) return sendJson(res, 404, { ok: false, issues: [{ code: "KILN_PROJECT_NOT_FOUND" }] });
        const runner = runnerFor(cast, payload.policy);
        try {
          const verb = payload.verb ?? "invoke";
          if (verb === "observe") {
            const result = await runner.observe();
            return sendJson(res, 200, { ok: true, observation: result.observation, stamp: result.stamp });
          }
          if (verb === "act") {
            const result = await runner.act({ ...(payload.args ?? {}), type: payload.name ?? "" });
            return sendJson(res, 200, { ok: true, outcome: result.outcome, stamp: result.stamp });
          }
          const result = await runner.invoke(payload.name ?? "", payload.args ?? {});
          return sendJson(res, 200, { ok: true, result: result.value, stamp: result.stamp });
        } finally {
          await runner.unmount();
        }
      }

      if (route === "/" || route === "/index.html") return sendFile(res, path.join(WEB_ROOT, "index.html"));
      if (route === "/design") return sendFile(res, path.join(WEB_ROOT, "design.html"));
      if (route === "/favicon.svg") return sendFile(res, path.join(BRAND_ROOT, "favicon.svg"));

      if (route.startsWith("/brand/")) {
        const file = safeJoin(BRAND_ROOT, route.slice("/brand/".length));
        if (file) return sendFile(res, file);
      }

      const asset = safeJoin(WEB_ROOT, route.slice(1));
      if (asset && (await stat(asset).catch(() => null))?.isFile()) return sendFile(res, asset);

      return sendJson(res, 404, { ok: false, issues: [{ code: "KILN_PROJECT_NOT_FOUND", message: route }] });
    } catch (error) {
      return sendIssues(res, 500, [toIssue(error)]);
    }
  });

  const port = options.port ?? 4310;
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;

  return {
    url: `http://${host}:${actual}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const timer of timers) clearInterval(timer);
        for (const stream of streams) stream.end();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
