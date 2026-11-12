import type { ActOutcome, CastContext, CastPact, Intent, Observation } from "#pact";

const WINDOW_KEY = "window";
const DEFAULT_WINDOW = 7;

async function currentWindow(ctx: CastContext): Promise<number> {
  const raw = await ctx.cap.store.read(WINDOW_KEY);
  return typeof raw === "number" && raw > 0 ? raw : DEFAULT_WINDOW;
}

interface LogResult {
  readonly ok: boolean;
  readonly authors: readonly string[];
  readonly reason?: string;
}

async function recentAuthors(ctx: CastContext, days: number): Promise<LogResult> {
  const res = await ctx.cap.shell("git", ["log", `--since=${days} days ago`, "--format=%an"]);
  if (res.code !== 0) {
    // 非零退出码是正常结果（比如目录不是 git 仓库），转成结构化说明而不是抛异常。
    return { ok: false, authors: [], reason: res.stderr.trim().slice(0, 160) || `git 退出码 ${res.code}` };
  }
  return {
    ok: true,
    authors: res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}

function tally(authors: readonly string[]) {
  const counts = new Map<string, number>();
  for (const author of authors) counts.set(author, (counts.get(author) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const first = ranked[0];
  return {
    commits: authors.length,
    authors: ranked.length,
    top: first ? first[0] : null,
    topCommits: first ? first[1] : 0,
    ranked,
  };
}

async function snapshot(ctx: CastContext): Promise<Observation> {
  const window = await currentWindow(ctx);
  const log = await recentAuthors(ctx, window);
  const stats = tally(log.authors);
  const fields: Record<string, unknown> = {
    window,
    gitOk: log.ok,
    commits: stats.commits,
    authors: stats.authors,
    top: stats.top,
  };
  if (log.reason) fields.reason = log.reason;
  return { fields, at: Date.now() };
}

export const pact: CastPact = {
  describe() {
    return {
      id: "git-lens",
      version: "0.1.0",
      title: "Git 洞察面板",
      summary: "读当前工作区的提交历史，给出热度、作者分布与最近节奏",
      shape: "panel",
      intents: ["git", "提交历史", "作者分布", "代码活跃度"],
    };
  },

  async invoke(tool: string, args: Record<string, unknown>, ctx: CastContext): Promise<unknown> {
    const days = typeof args.days === "number" && args.days > 0 ? Math.floor(args.days) : await currentWindow(ctx);
    const log = await recentAuthors(ctx, days);

    if (!log.ok) {
      return { ok: false, reason: log.reason ?? "git 不可用" };
    }

    const stats = tally(log.authors);

    if (tool === "commit_stats") {
      return {
        ok: true,
        commits: stats.commits,
        authors: stats.authors,
        top: stats.top,
        topCommits: stats.topCommits,
      };
    }

    if (tool === "author_share") {
      return {
        ok: true,
        days,
        rows: stats.ranked.map(([author, commits]) => ({
          author,
          commits,
          share: stats.commits === 0 ? 0 : Math.round((commits / stats.commits) * 1000) / 1000,
        })),
      };
    }

    return { ok: false, reason: `未实现工具: ${tool}` };
  },

  observe: snapshot,

  async act(intent: Intent, ctx: CastContext): Promise<ActOutcome> {
    if (intent.type === "apply-window") {
      const days = Number(intent.days);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        // 自己校验、自己拒绝，并且不动状态。调用方一次就知道边界在哪。
        return { ok: false, note: "days 必须是 1..365 的整数" };
      }
      await ctx.cap.store.write(WINDOW_KEY, days);
      return { ok: true, state: await snapshot(ctx), note: `窗口已切到 ${days} 天` };
    }

    if (intent.type === "reset") {
      await ctx.cap.store.write(WINDOW_KEY, DEFAULT_WINDOW);
      return { ok: true, state: await snapshot(ctx), note: "已恢复默认窗口" };
    }

    return { ok: false, note: `未知动作: ${intent.type}` };
  },
};
