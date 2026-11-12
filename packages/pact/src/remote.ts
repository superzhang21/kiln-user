import type { CastManifest } from "#grain";
import type { CastPact, CastContext } from "./verbs.ts";

/**
 * `entry.kind: "service"` 的实现：四动词通过受控网络句柄转发到远端服务。
 * 远端 URL 写在 `entry.module`，实际能否访问由 `grants.net` 与宿主策略决定。
 */
export function createRemotePact(manifest: CastManifest): CastPact {
  const endpoint = manifest.entry.module;
  const call = async (ctx: CastContext, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await ctx.cap.net(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`远端服务返回 ${response.status}`);
    }
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    return parsed;
  };
  const pact: CastPact = {
    describe() {
      return {
        id: manifest.id,
        version: manifest.version,
        title: manifest.title,
        summary: manifest.summary,
        shape: manifest.shape,
        intents: manifest.intents,
      };
    },
  };
  if (manifest.verbs.includes("invoke")) {
    pact.invoke = async (tool: string, args: Record<string, unknown>, ctx: CastContext) => {
      const reply = await call(ctx, { verb: "invoke", tool, args });
      return reply.result ?? reply;
    };
  }
  if (manifest.verbs.includes("observe")) {
    pact.observe = async (ctx: CastContext) => {
      const reply = await call(ctx, { verb: "observe" });
      return reply.observation as never;
    };
  }
  if (manifest.verbs.includes("act")) {
    pact.act = async (intent, ctx: CastContext) => {
      const reply = await call(ctx, { verb: "act", intent });
      return reply.outcome as never;
    };
  }
  return pact;
}
