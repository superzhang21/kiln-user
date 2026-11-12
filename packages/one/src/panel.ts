import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KilnError, toIssue, type Issue } from "#grain";
import { readUpConfig, resolveBundleDir, resolveRuntimeRoot } from "./bundle.ts";
import { OneIssues } from "./errors.ts";
import { runHandshake } from "./handshake.ts";
import { permissionsCommand, statusOf, upBundle, downBundle } from "./up.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = path.resolve(HERE, "..", "web", "panel.html");
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

export interface PanelOptions {
  readonly bundle?: string;
  readonly port?: number;
  readonly host?: string;
  readonly runtimeRoot?: string;
}

export interface Panel {
  readonly url: string;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: string, type = "application/json; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  send(res, status, JSON.stringify(payload, null, 2));
}

function sendIssues(res: ServerResponse, status: number, issues: readonly Issue[]): void {
  sendJson(res, status, { ok: false, issues });
}

function issuesOf(error: unknown): Issue[] {
  if (error instanceof OneIssues) return [...error.issues];
  return [toIssue(error)];
}

async function readBody(req: IncomingMessage, limitBytes = 64_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new KilnError({ code: "KILN_ONE_USAGE", message: "请求体过大" });
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KilnError({ code: "KILN_ONE_USAGE", message: "请求体必须是 JSON 对象" });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new KilnError({ code: "KILN_ONE_USAGE", message: "请求体必须是 JSON 对象" });
  }
  return parsed as Record<string, unknown>;
}

/** 本机状态面板：查看连接/权限/自检，并支持一键撤销、断开、重连与重新自检。 */
export async function startPanel(options: PanelOptions = {}): Promise<Panel> {
  const bundleDir = resolveBundleDir(options.bundle);
  const runtimeRoot = resolveRuntimeRoot(bundleDir, options.runtimeRoot);
  const host = options.host ?? "127.0.0.1";

  const server = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      if (origin && !LOCAL_ORIGIN.test(origin)) {
        return sendIssues(res, 403, [
          toIssue(new KilnError({ code: "KILN_ONE_USAGE", message: "状态面板只接受本机来源的请求" })),
        ]);
      }
      const route = new URL(req.url ?? "/", `http://${host}`).pathname;

      if (route === "/" && req.method === "GET") {
        return send(res, 200, await readFile(PANEL_HTML, "utf8"), "text/html; charset=utf-8");
      }
      if (route === "/api/status" && req.method === "GET") {
        return sendJson(res, 200, await statusOf(bundleDir));
      }
      if (route === "/api/config" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, config: await readUpConfig(bundleDir) });
      }
      if (route === "/api/permissions" && req.method === "POST") {
        const body = await readBody(req);
        const action = body.action;
        if (action !== "grant" && action !== "revoke") {
          return sendIssues(res, 400, [
            toIssue(new KilnError({ code: "KILN_ONE_USAGE", message: "action 只能是 grant 或 revoke" })),
          ]);
        }
        return sendJson(res, 200, await permissionsCommand(bundleDir, action));
      }
      if (route === "/api/connections" && req.method === "POST") {
        const body = await readBody(req);
        if (body.action === "disconnect") return sendJson(res, 200, await downBundle(bundleDir));
        if (body.action === "reconnect") {
          const current = await statusOf(bundleDir);
          if (current.permissions.status !== "granted") {
            return sendIssues(res, 409, [
              toIssue(
                new KilnError({
                  code: "KILN_ONE_APPROVAL",
                  message: "授权已撤销，请先点击「重新授权」再重连",
                  hint: "在状态面板点击「重新授权」，或运行 kiln permissions grant <bundle>。",
                }),
              ),
            ]);
          }
          return sendJson(res, 200, await upBundle({ bundle: bundleDir, runtimeRoot, requireApproval: true }));
        }
        return sendIssues(res, 400, [
          toIssue(new KilnError({ code: "KILN_ONE_USAGE", message: "action 只能是 disconnect 或 reconnect" })),
        ]);
      }
      if (route === "/api/handshake" && req.method === "POST") {
        const config = await readUpConfig(bundleDir);
        return sendJson(res, 200, { ok: true, handshake: await runHandshake({ bundleDir, config, runtimeRoot }) });
      }
      return sendIssues(res, 404, [toIssue(new KilnError({ code: "KILN_ONE_USAGE", message: `未知路由: ${route}` }))]);
    } catch (error) {
      return sendIssues(
        res,
        error instanceof KilnError && error.code === "KILN_ONE_USAGE" ? 400 : 500,
        issuesOf(error),
      );
    }
  });

  const port = options.port ?? 4311;
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
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
