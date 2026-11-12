import { randomUUID } from "node:crypto";
import { KilnError, docFor, type Issue } from "#grain";
import type { ActOutcome, CastContext, Intent, Observation } from "#pact";
import type { LoadedCast } from "#pact";
import { CapabilityGateway } from "./gateway.ts";
import { resolveGrants, type HostPolicy } from "./policy.ts";
import type { Registry } from "./registry.ts";
import type { AuditRecord } from "./audit.ts";

export interface RunnerPaths {
  /** 每个 cast 一个数据目录，互不干扰。 */
  readonly dataDir: string;
  readonly workspace: string;
}

export interface RunOptions {
  readonly cast: LoadedCast;
  readonly policy: HostPolicy;
  readonly paths: RunnerPaths;
  readonly timeoutMs?: number;
  readonly registry?: Registry;
  readonly logger?: (line: string) => void;
  readonly audit?: (record: AuditRecord) => void;
}

export interface RunStamp {
  readonly castId: string;
  readonly verb: string;
  readonly name: string;
  readonly callId: string;
  readonly ms: number;
}

/**
 * 执行器只做四件事：解析授权、造上下文、跑动词、按预算裁剪结果。
 * 配额、审计、计费这类横切能力挂在中间件上——多塞一件进来，就等于所有宿主都要跟着改。
 */
export class CastRunner {
  readonly #opts: RunOptions;
  readonly #gateway: CapabilityGateway;
  readonly #denials: Issue[] = [];
  readonly grantIssues: readonly Issue[];
  #mounted = false;

  constructor(options: RunOptions) {
    this.#opts = options;
    const { manifest } = options.cast;
    const resolved = resolveGrants(manifest.grants, options.policy);
    this.#gateway = new CapabilityGateway({
      castId: manifest.id,
      root: options.cast.dir,
      dataDir: options.paths.dataDir,
      workspace: options.paths.workspace,
      resolved,
      grants: manifest.grants,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.audit !== undefined ? { audit: options.audit } : {}),
      onDeny: (denied: Issue) => {
        this.#denials.push(denied);
      },
    });
    const dropped = Object.entries(resolved)
      .filter(([, scope]) => (scope.dropped?.length ?? 0) > 0)
      .map(([cap, scope]) => `${cap}: ${scope.dropped?.join(",")}`);
    this.grantIssues = dropped.map((d) => ({
      code: "KILN_GRANT_PATHVAR",
      message: `部分授权被裁剪 — ${d}`,
      hint: "宿主白名单比清单更严，超出部分不会生效。",
      docs: docFor("KILN_GRANT_PATHVAR"),
    }));
  }

  #context(): CastContext {
    return this.#gateway.createContext(randomUUID());
  }

  /**
   * 动词返回后再结算，而不是拒绝时立刻抛：一次调用里的多个能力操作不会执行到一半被掐断，
   * 状态不会停在半路。代价是 cast 先拿到了业务返回值——所以必须用账本把它覆盖掉。
   */
  #settle(): void {
    const first = this.#denials[0];
    this.#denials.length = 0;
    if (first) throw KilnError.fromIssue(first);
  }

  /**
   * 生命周期：首个动词调用前触发 onMount，宿主关闭 / 卸载时触发 onUnmount。
   * 两者都幂等；mount 失败会让本次调用直接失败，而不是带病运行。
   */
  async mount(): Promise<void> {
    if (this.#mounted) return;
    this.#mounted = true;
    const hook = this.#opts.cast.pact.onMount;
    if (typeof hook === "function") await hook.call(this.#opts.cast.pact, this.#context());
  }

  async unmount(): Promise<void> {
    if (!this.#mounted) return;
    this.#mounted = false;
    const hook = this.#opts.cast.pact.onUnmount;
    if (typeof hook === "function") await hook.call(this.#opts.cast.pact, this.#context());
  }

  async describe(): Promise<unknown> {
    return await this.#opts.cast.pact.describe();
  }

  async invoke(tool: string, args: Record<string, unknown> = {}): Promise<{ value: unknown; stamp: RunStamp }> {
    const pact = this.#opts.cast.pact;
    if (typeof pact.invoke !== "function") {
      throw new KilnError({
        code: "KILN_PACT_MISSING_VERB",
        message: "该 cast 不支持 invoke",
        detail: { cast: this.#opts.cast.manifest.id, verbs: this.#opts.cast.manifest.verbs },
      });
    }
    const declared = this.#opts.cast.manifest.tools.some((t) => t.name === tool);
    if (!declared) {
      throw new KilnError({
        code: "KILN_PACT_MISMATCH",
        message: `未声明的工具: ${tool}`,
        detail: { tool, declared: this.#opts.cast.manifest.tools.map((t) => t.name) },
      });
    }

    await this.mount();
    const started = Date.now();
    const ctx = this.#context();
    const run = async () => pact.invoke!(tool, args, ctx);
    this.#denials.length = 0;
    const value = this.#opts.registry
      ? await this.#opts.registry.compose(() => run())({
          castId: this.#opts.cast.manifest.id,
          verb: "invoke",
          name: tool,
          args,
        })
      : await run();
    this.#settle();

    return {
      value,
      stamp: {
        castId: this.#opts.cast.manifest.id,
        verb: "invoke",
        name: tool,
        callId: ctx.callId,
        ms: Date.now() - started,
      },
    };
  }

  async observe(): Promise<{ observation: Observation; stamp: RunStamp }> {
    const pact = this.#opts.cast.pact;
    if (typeof pact.observe !== "function") {
      throw new KilnError({
        code: "KILN_PACT_MISSING_VERB",
        message: "该 cast 不支持 observe",
        detail: { cast: this.#opts.cast.manifest.id },
      });
    }
    await this.mount();
    const started = Date.now();
    const ctx = this.#context();
    this.#denials.length = 0;
    const raw = await pact.observe(ctx);
    this.#settle();
    const observation = trimToBudget(raw, this.#opts.cast.manifest.budget.observeBytes);
    return {
      observation,
      stamp: {
        castId: this.#opts.cast.manifest.id,
        verb: "observe",
        name: "-",
        callId: ctx.callId,
        ms: Date.now() - started,
      },
    };
  }

  async act(intent: Intent): Promise<{ outcome: ActOutcome; stamp: RunStamp }> {
    const pact = this.#opts.cast.pact;
    if (typeof pact.act !== "function") {
      throw new KilnError({
        code: "KILN_PACT_MISSING_VERB",
        message: "该 cast 不支持 act",
        detail: { cast: this.#opts.cast.manifest.id },
      });
    }
    const allowed = new Set(this.#opts.cast.manifest.actions.map((a) => a.name));
    if (!allowed.has(intent.type)) {
      throw new KilnError({
        code: "KILN_PACT_MISMATCH",
        message: `未声明的动作: ${intent.type}`,
        detail: { intent: intent.type, declared: [...allowed] },
      });
    }
    await this.mount();
    const started = Date.now();
    const ctx = this.#context();
    this.#denials.length = 0;
    const outcome = await pact.act(intent, ctx);
    this.#settle();
    return {
      outcome,
      stamp: {
        castId: this.#opts.cast.manifest.id,
        verb: "act",
        name: intent.type,
        callId: ctx.callId,
        ms: Date.now() - started,
      },
    };
  }
}

/**
 * 按字节预算裁剪 observe。被丢的字段名进 truncated，不静默丢——
 * 调用方要知道「还有更多」，才能换更窄的查询。
 */
export function trimToBudget(observation: Observation, budgetBytes: number): Observation {
  const size = (o: Observation) => Buffer.byteLength(JSON.stringify(o.fields), "utf8");
  if (size(observation) <= budgetBytes) return observation;

  const entries = Object.entries(observation.fields);
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of entries) {
    const candidate = { ...kept, [key]: value };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= budgetBytes) {
      kept[key] = value;
    } else {
      dropped.push(key);
    }
  }
  return {
    fields: kept,
    truncated: [...(observation.truncated ?? []), ...dropped],
    at: observation.at,
  };
}
