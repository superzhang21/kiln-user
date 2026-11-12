import type { Grants } from "#grain";

export type Decision = "allow" | "ask" | "deny";

export interface HostRule {
  readonly mode: Decision;
  /** 只对 shell / net 有意义：允许的具体条目。省略表示该模式下不限。 */
  readonly allow?: readonly string[];
}

export interface HostPolicy {
  readonly default: Decision;
  readonly capabilities: Record<string, HostRule>;
  /** 非交互环境（agent、CI）下遇到 ask 的处理方式。默认拒绝。 */
  readonly onAsk?: "deny" | "allow";
}

export const STRICT_POLICY: HostPolicy = {
  default: "deny",
  capabilities: {
    store: { mode: "allow" },
    file: { mode: "allow" },
    shell: { mode: "ask" },
    net: { mode: "ask" },
    model: { mode: "ask" },
    agent: { mode: "deny" },
  },
  onAsk: "deny",
};

export const RELAXED_POLICY: HostPolicy = {
  default: "allow",
  capabilities: {
    store: { mode: "allow" },
    file: { mode: "allow" },
    shell: { mode: "allow" },
    net: { mode: "allow" },
    model: { mode: "allow" },
    agent: { mode: "allow" },
  },
  onAsk: "allow",
};

/**
 * 本地开发策略：信任 cast 自己的清单声明，不再加一层白名单。
 * 这是「作者跑自己的东西」的默认档位，不要把线上宿主也设成这个。
 */
export const LOCAL_POLICY: HostPolicy = {
  default: "allow",
  capabilities: {},
  onAsk: "allow",
};

export interface ResolvedScope {
  readonly decision: Decision;
  /** 给人看的一句话依据。会被放进 KILN_CAP_DENIED 的 detail.reason。 */
  readonly reason: string;
  readonly allowed?: readonly string[];
  readonly dropped?: readonly string[];
}

export type ResolvedGrants = Record<string, ResolvedScope>;

const LISTY = new Set(["shell", "net"]);

/**
 * 清单的 grants 是「申请」，宿主策略里 allow 是「上限」，取交集。
 * 只有全部条目都超出上限才整体拒绝；部分超限时裁掉超出的部分并记进 dropped——换到更严的宿主时少几个能力，
 * 但跑得起来，且原因可查。
 */
export function resolveGrants(grants: Grants, policy: HostPolicy): ResolvedGrants {
  const out: ResolvedGrants = {};
  const declared = grants as Record<string, unknown>;

  for (const [cap, raw] of Object.entries(declared)) {
    if (raw === undefined || raw === null) continue;
    const rule = policy.capabilities[cap];

    if (!rule) {
      out[cap] = {
        decision: policy.default,
        reason: `宿主策略未配置能力 ${cap}，按默认策略 ${policy.default} 处理`,
      };
      continue;
    }

    let decision = rule.mode;
    if (decision === "ask") {
      decision = policy.onAsk === "allow" ? "allow" : "deny";
    }

    if (decision !== "allow") {
      out[cap] = {
        decision,
        reason:
          rule.mode === "ask"
            ? `宿主对 ${cap} 要求人工确认，当前为非交互环境，按 onAsk=${policy.onAsk ?? "deny"} 处理`
            : `宿主策略禁止能力 ${cap}`,
      };
      continue;
    }

    if (LISTY.has(cap) && rule.allow !== undefined) {
      const requested = extractList(raw, cap);
      const ceiling = new Set(rule.allow);
      const kept = requested.filter((x) => ceiling.has(x));
      const dropped = requested.filter((x) => !ceiling.has(x));
      if (kept.length === 0 && requested.length > 0) {
        out[cap] = {
          decision: "deny",
          reason: `申请的 ${cap} 条目 ${requested.join(", ")} 全部不在宿主白名单内`,
          allowed: [],
          dropped,
        };
        continue;
      }
      out[cap] = {
        decision: "allow",
        reason: dropped.length > 0 ? `放行 ${kept.length} 项，${dropped.length} 项超出宿主白名单` : "在宿主白名单内",
        allowed: kept,
        dropped,
      };
      continue;
    }

    out[cap] = { decision: "allow", reason: "宿主策略允许" };
  }

  return out;
}

function extractList(raw: unknown, cap: string): string[] {
  if (raw === null || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  if (cap === "shell" || cap === "net") {
    const allow = obj.allow;
    if (Array.isArray(allow)) return allow.filter((x): x is string => typeof x === "string");
  }
  return [];
}

export function decisionOf(resolved: ResolvedGrants, cap: string): Decision {
  const scope = resolved[cap];
  return scope ? scope.decision : "deny";
}
