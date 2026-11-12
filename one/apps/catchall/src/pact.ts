import { createHash, randomBytes } from "node:crypto";
import type { ActOutcome, CastContext, CastPact, Intent, Observation } from "#pact";

const INDEX_KEY = "index";
const VIEW_KEY = "view";
const ITEM_PREFIX = "item:";
const ID_RE = /^c_[0-9a-f]{12}$/;
const MAX_TEXT = 8_000;
const MAX_TITLE = 120;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 32;
const MAX_ITEMS = 10_000;
const EXPORT_LIMIT = 500;
const CLEAR_LIMIT = 200;
const DAY = 86_400_000;

const KINDS = ["todo", "link", "bill", "note", "idea"] as const;
type Kind = (typeof KINDS)[number];
type View = "day" | "week" | "all";

interface Item {
  readonly id: string;
  readonly text: string;
  readonly title: string;
  readonly kind: Kind;
  readonly tags: readonly string[];
  readonly due: string | null;
  readonly ts: number;
  readonly done: boolean;
  readonly pinned: boolean;
  readonly hash: string;
}

interface IndexEntry {
  readonly id: string;
  readonly ts: number;
  readonly kind: Kind;
  readonly title: string;
  readonly q: string;
  readonly hash: string;
  readonly done: boolean;
  readonly pinned: boolean;
  readonly due: string | null;
  /** 展示用片段随索引一起存，检索时无需再逐条读全文。 */
  readonly snippet: string;
}

/** 同一进程内串行化写入，避免并发 capture 互相覆盖索引。跨进程由 readIndex 自愈兜底。 */
let writeQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function textOf(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/\u0000/g, "").trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function hashOf(text: string, title: string): string {
  return createHash("sha256")
    .update(`${normalize(text)}|${normalize(title)}`)
    .digest("hex")
    .slice(0, 32);
}

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

function classify(text: string, title: string): Kind {
  const sample = `${title} ${text}`;
  if (/https?:\/\//i.test(sample)) return "link";
  // 时间与待办语义优先于金额类别：「明天交房租发票」首先是一件要办的事。
  if (/(明天|今天|后天|周[一二三四五六日末]?|截止|deadline|记得|待办|要交|前完成|提醒我|todo)/i.test(sample)) {
    return "todo";
  }
  if (/(发票|账单|报销|付款|缴费|房租|价格|[¥￥]\s*\d|\d+\s*元)/.test(sample)) return "bill";
  if (/(想法|灵感|点子|也许可以|试试看)/.test(sample)) return "idea";
  return "note";
}

function tagsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const tag = textOf(entry, MAX_TAG_LEN).replace(/\s/g, "");
    if (tag !== "" && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

type DueResult = { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly reason: string };

function parseDue(value: unknown): DueResult {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { ok: false, reason: "due 必须是 YYYY-MM-DD 格式" };
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return { ok: false, reason: "due 不是有效日期" };
  }
  return { ok: true, value };
}

function entryOf(item: Item): IndexEntry {
  return {
    id: item.id,
    ts: item.ts,
    kind: item.kind,
    title: item.title,
    q: normalize(`${item.title} ${item.text} ${item.tags.join(" ")}`).slice(0, 300),
    hash: item.hash,
    done: item.done,
    pinned: item.pinned,
    due: item.due,
    snippet: item.text.slice(0, 80),
  };
}

function isItem(value: unknown): value is Item {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<Item>;
  return (
    typeof item.id === "string" &&
    ID_RE.test(item.id) &&
    typeof item.text === "string" &&
    typeof item.title === "string" &&
    isKind(item.kind) &&
    Array.isArray(item.tags) &&
    typeof item.ts === "number" &&
    typeof item.done === "boolean" &&
    typeof item.pinned === "boolean" &&
    typeof item.hash === "string"
  );
}

function isEntry(value: unknown): value is IndexEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<IndexEntry>;
  return (
    typeof entry.id === "string" &&
    ID_RE.test(entry.id) &&
    typeof entry.q === "string" &&
    typeof entry.ts === "number" &&
    typeof entry.title === "string" &&
    typeof entry.hash === "string" &&
    typeof entry.done === "boolean" &&
    typeof entry.pinned === "boolean" &&
    typeof entry.snippet === "string" &&
    isKind(entry.kind)
  );
}

async function rebuildIndex(ctx: CastContext, itemKeys: readonly string[]): Promise<IndexEntry[]> {
  const entries: IndexEntry[] = [];
  for (const key of itemKeys.slice(0, MAX_ITEMS)) {
    const raw = await ctx.cap.store.read(key);
    if (isItem(raw)) entries.push(entryOf(raw));
  }
  return entries.sort((a, b) => b.ts - a.ts);
}

/**
 * 索引只是读加速缓存，不是唯一事实来源。
 * 条目数对不上、有脏数据或被并发写覆盖时，从 item:* 重建，避免丢记录。
 */
async function readIndex(ctx: CastContext): Promise<IndexEntry[]> {
  const keys = await ctx.cap.store.keys();
  const itemKeys = keys.filter((key) => key.startsWith(ITEM_PREFIX) && ID_RE.test(key.slice(ITEM_PREFIX.length)));
  const raw = await ctx.cap.store.read(INDEX_KEY);
  const cached = Array.isArray(raw) ? raw.filter(isEntry) : null;
  const keySet = new Set(itemKeys);
  const consistent =
    cached !== null &&
    cached.length === itemKeys.length &&
    new Set(cached.map((entry) => entry.id)).size === cached.length &&
    cached.every((entry) => keySet.has(`${ITEM_PREFIX}${entry.id}`));
  if (consistent) return cached;
  const rebuilt = await rebuildIndex(ctx, itemKeys);
  await ctx.cap.store.write(INDEX_KEY, rebuilt);
  return rebuilt;
}

async function readView(ctx: CastContext): Promise<View> {
  const raw = await ctx.cap.store.read(VIEW_KEY);
  return raw === "day" || raw === "week" || raw === "all" ? raw : "day";
}

function emptyKinds(): Record<Kind, number> {
  return { todo: 0, link: 0, bill: 0, note: 0, idea: 0 };
}

function tally(entries: readonly IndexEntry[]): Record<Kind, number> {
  const out = emptyKinds();
  for (const entry of entries) out[entry.kind] += 1;
  return out;
}

function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dueSoon(entries: readonly IndexEntry[], now: number): number {
  const horizon = now + 3 * DAY;
  return entries.filter((entry) => {
    if (entry.done || entry.due === null) return false;
    const deadline = new Date(`${entry.due}T23:59:59`).getTime();
    return !Number.isNaN(deadline) && deadline >= now - DAY && deadline <= horizon;
  }).length;
}

/** 小摘要：核心字段在前，宿主按预算裁剪时先丢掉列表型字段。 */
async function snapshot(ctx: CastContext): Promise<Observation> {
  const index = await readIndex(ctx);
  const view = await readView(ctx);
  const now = Date.now();
  const open = index.filter((entry) => !entry.done);
  const sorted = [...index].sort((a, b) => b.ts - a.ts);
  const lastAt = sorted[0] ? new Date(sorted[0].ts).toISOString() : null;
  return {
    fields: {
      view,
      total: index.length,
      open: open.length,
      today: index.filter((entry) => entry.ts >= startOfDay(now)).length,
      dueSoon: dueSoon(open, now),
      byKind: tally(index),
      lastAt,
      pinned: index
        .filter((entry) => entry.pinned && !entry.done)
        .slice(0, 3)
        .map((entry) => ({ id: entry.id, title: entry.title })),
      recent: sorted.slice(0, 3).map((entry) => ({ id: entry.id, title: entry.title, kind: entry.kind })),
      tip: open.length > 0 ? `还有 ${open.length} 件未完成，${dueSoon(open, now)} 件临近到期` : "暂无未完成事项",
    },
    at: now,
  };
}

function clampLimit(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 5;
  return Math.min(10, Math.max(1, parsed));
}

function scoreEntry(entry: IndexEntry, query: string, tokens: readonly string[], now: number): number {
  if (tokens.length === 0) return 1;
  let score = 0;
  for (const token of tokens) if (entry.q.includes(token)) score += 3;
  if (entry.q.includes(query)) score += 10;
  if (normalize(entry.title).includes(query)) score += 2;
  if (score === 0) return 0;
  if (entry.pinned) score += 2;
  if (!entry.done) score += 1;
  score += Math.max(0, 2 - (now - entry.ts) / (7 * DAY));
  return score;
}

async function capture(args: Record<string, unknown>, ctx: CastContext): Promise<unknown> {
  const rawText = typeof args.text === "string" ? args.text : "";
  const text = textOf(rawText, MAX_TEXT);
  if (text === "") return { ok: false, reason: "text 不能为空" };
  const rawTitle = typeof args.title === "string" ? args.title : "";
  const title = textOf(rawTitle, MAX_TITLE) || text.slice(0, 40);
  const hash = hashOf(text, title);
  if (args.kind !== undefined && !isKind(args.kind)) {
    return { ok: false, reason: `kind 只能是 ${KINDS.join(" / ")}` };
  }
  const due = parseDue(args.due);
  if (!due.ok) return { ok: false, reason: due.reason };

  return await serialize(async () => {
    const index = await readIndex(ctx);
    const existing = index.find((entry) => entry.hash === hash);
    if (existing) {
      return { ok: true, id: existing.id, dedup: true, kind: existing.kind, total: index.length };
    }
    if (index.length >= MAX_ITEMS) return { ok: false, reason: `台账已达上限 ${MAX_ITEMS} 条，请先清理` };
    const item: Item = {
      id: `c_${randomBytes(6).toString("hex")}`,
      text,
      title,
      kind: isKind(args.kind) ? args.kind : classify(text, title),
      tags: tagsOf(args.tags),
      due: due.value,
      ts: Date.now(),
      done: false,
      pinned: false,
      hash,
    };
    const next = [entryOf(item), ...index];
    // 两个 key 落在同一 store.json：顺序写，避免 Windows 上并发 open 触发 EBUSY。
    await ctx.cap.store.write(`${ITEM_PREFIX}${item.id}`, item);
    await ctx.cap.store.write(INDEX_KEY, next);
    return {
      ok: true,
      id: item.id,
      dedup: false,
      kind: item.kind,
      total: next.length,
      ...(rawText.trim().length > MAX_TEXT || rawTitle.trim().length > MAX_TITLE ? { truncated: true } : {}),
    };
  });
}

async function find(args: Record<string, unknown>, ctx: CastContext): Promise<unknown> {
  const query = normalize(textOf(args.query, 200));
  const tokens = query.split(" ").filter((token) => token.length > 0);
  const limit = clampLimit(args.limit);
  const includeDone = args.includeDone === true;
  if (args.kind !== undefined && !isKind(args.kind)) {
    return { ok: false, reason: `kind 只能是 ${KINDS.join(" / ")}` };
  }
  const index = await readIndex(ctx);
  const now = Date.now();
  const matches = index
    .filter((entry) => (includeDone || !entry.done) && (args.kind === undefined || entry.kind === args.kind))
    .map((entry) => ({ entry, score: scoreEntry(entry, query, tokens, now) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.ts - a.entry.ts);
  // 索引自带展示所需的全部字段：一次读索引即可完成检索，不再对 top N 逐条读全文。
  const rows = matches.slice(0, limit).map(({ entry }) => ({
    id: entry.id,
    title: entry.title,
    kind: entry.kind,
    done: entry.done,
    pinned: entry.pinned,
    due: entry.due,
    ts: entry.ts,
    snippet: entry.snippet,
  }));
  return { ok: true, query, total: matches.length, limit, rows };
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function digest(args: Record<string, unknown>, ctx: CastContext): Promise<unknown> {
  const period = args.period === "week" ? "week" : "day";
  const known = args.period === undefined || args.period === "day" || args.period === "week";
  const index = await readIndex(ctx);
  const now = Date.now();
  const from = period === "day" ? startOfDay(now) : now - 7 * DAY;
  const window = index.filter((entry) => entry.ts >= from).sort((a, b) => b.ts - a.ts);
  const done = window.filter((entry) => entry.done).length;
  const payload = {
    ok: true,
    period,
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    total: index.length,
    added: window.length,
    done,
    open: window.length - done,
    byKind: tally(window),
    highlights: window
      .slice(0, 3)
      .map((entry) => ({ id: entry.id, title: entry.title.slice(0, 40), kind: entry.kind })),
    ...(known ? {} : { note: "period 只支持 day / week，已按 day 处理" }),
  };
  return { ...payload, bytes: bytesOf(payload) };
}

async function stats(args: Record<string, unknown>, ctx: CastContext): Promise<unknown> {
  void args;
  const index = await readIndex(ctx);
  const sorted = [...index].sort((a, b) => b.ts - a.ts);
  return {
    ok: true,
    total: index.length,
    open: index.filter((entry) => !entry.done).length,
    done: index.filter((entry) => entry.done).length,
    pinned: index.filter((entry) => entry.pinned).length,
    byKind: tally(index),
    lastAt: sorted[0] ? new Date(sorted[0].ts).toISOString() : null,
    indexBytes: bytesOf(index),
    view: await readView(ctx),
  };
}

function idOf(args: Record<string, unknown>): string | null {
  const id = args.id;
  return typeof id === "string" && ID_RE.test(id) ? id : null;
}

async function get(args: Record<string, unknown>, ctx: CastContext): Promise<unknown> {
  const id = idOf(args);
  if (!id) return { ok: false, reason: "id 格式不合法" };
  const raw = await ctx.cap.store.read(`${ITEM_PREFIX}${id}`);
  if (!isItem(raw)) return { ok: false, reason: "未找到该记录" };
  return { ok: true, item: raw };
}

async function remove(args: Record<string, unknown>, ctx: CastContext): Promise<unknown> {
  const id = idOf(args);
  if (!id) return { ok: false, reason: "id 格式不合法" };
  return await serialize(async () => {
    const index = await readIndex(ctx);
    if (!index.some((entry) => entry.id === id)) return { ok: false, reason: "未找到该记录", removed: false };
    const next = index.filter((entry) => entry.id !== id);
    await ctx.cap.store.drop(`${ITEM_PREFIX}${id}`);
    await ctx.cap.store.write(INDEX_KEY, next);
    return { ok: true, removed: true, total: next.length };
  });
}

async function exportList(args: Record<string, unknown>, ctx: CastContext): Promise<unknown> {
  const format = args.format === "json" ? "json" : "md";
  if (args.format !== undefined && args.format !== "json" && args.format !== "md") {
    return { ok: false, reason: "format 只能是 md / json" };
  }
  if (args.scope !== undefined && args.scope !== "all" && args.scope !== "open" && args.scope !== "done") {
    return { ok: false, reason: "scope 只能是 all / open / done" };
  }
  const index = await readIndex(ctx);
  const selected = index.filter((entry) => {
    if (args.scope === "open") return !entry.done;
    if (args.scope === "done") return entry.done;
    return true;
  });
  const limited = selected.slice(0, EXPORT_LIMIT);
  const rows: Item[] = [];
  for (const entry of limited) {
    const raw = await ctx.cap.store.read(`${ITEM_PREFIX}${entry.id}`);
    if (isItem(raw)) rows.push(raw);
  }
  const body =
    format === "json"
      ? `${JSON.stringify(rows, null, 2)}\n`
      : `# 随手收导出 · ${new Date().toISOString().slice(0, 10)}\n\n${rows
          .map(
            (item) =>
              `- [${item.done ? "x" : " "}] ${item.title}${item.pinned ? " (置顶)" : ""} (${item.kind}${item.due ? `, 截止 ${item.due}` : ""})\n  ${item.text.replace(/\n/g, " ")}`,
          )
          .join("\n")}\n`;
  const file = `{castdata}/exports/catchall-${new Date().toISOString().slice(0, 10)}.${format}`;
  await ctx.cap.file.write(file, body);
  return {
    ok: true,
    path: file,
    bytes: Buffer.byteLength(body, "utf8"),
    rows: rows.length,
    truncated: selected.length > limited.length,
  };
}

async function mutate(
  id: string | null,
  ctx: CastContext,
  apply: (item: Item) => Item,
  note: string,
): Promise<ActOutcome> {
  if (!id) return { ok: false, note: "id 格式不合法" };
  return await serialize(async () => {
    const index = await readIndex(ctx);
    const position = index.findIndex((entry) => entry.id === id);
    if (position < 0) return { ok: false, note: "未找到该记录" };
    const raw = await ctx.cap.store.read(`${ITEM_PREFIX}${id}`);
    if (!isItem(raw)) return { ok: false, note: "记录数据损坏，请重建或删除" };
    const updated = apply(raw);
    const next = [...index];
    next[position] = entryOf(updated);
    await ctx.cap.store.write(`${ITEM_PREFIX}${id}`, updated);
    await ctx.cap.store.write(INDEX_KEY, next);
    return { ok: true, state: await snapshot(ctx), note };
  });
}

export const pact: CastPact = {
  describe() {
    return {
      id: "catchall",
      version: "0.1.0",
      title: "随手收",
      summary: "把散落的截图文字、链接、待办和一句话收进本地台账，随时查、每天问、每周汇总",
      shape: "panel",
      intents: ["随手记", "收纳", "待办", "查找", "资料", "日报", "周报", "摘要", "发票", "链接"],
    };
  },

  async invoke(tool: string, args: Record<string, unknown>, ctx: CastContext): Promise<unknown> {
    switch (tool) {
      case "capture":
        return await capture(args, ctx);
      case "find":
        return await find(args, ctx);
      case "digest":
        return await digest(args, ctx);
      case "stats":
        return await stats(args, ctx);
      case "get":
        return await get(args, ctx);
      case "remove":
        return await remove(args, ctx);
      case "export_list":
        return await exportList(args, ctx);
      default:
        return { ok: false, reason: `未实现工具: ${tool}` };
    }
  },

  observe: snapshot,

  async act(intent: Intent, ctx: CastContext): Promise<ActOutcome> {
    if (intent.type === "set-view") {
      const period = intent.period;
      if (period !== "day" && period !== "week" && period !== "all") {
        return { ok: false, note: "period 只能是 day / week / all，状态未改变" };
      }
      await ctx.cap.store.write(VIEW_KEY, period);
      return { ok: true, state: await snapshot(ctx), note: `观察窗口已切到 ${period}` };
    }

    if (intent.type === "mark-done") {
      const id = idOf(intent);
      if (!id) return { ok: false, note: "id 格式不合法" };
      const current = await ctx.cap.store.read(`${ITEM_PREFIX}${id}`);
      if (isItem(current) && current.done) {
        return { ok: true, state: await snapshot(ctx), note: "该记录已完成（幂等）" };
      }
      return await mutate(id, ctx, (item) => ({ ...item, done: true }), "已标记完成");
    }

    if (intent.type === "pin") {
      const on = intent.on !== false && intent.on !== "false" && intent.on !== 0;
      return await mutate(idOf(intent), ctx, (item) => ({ ...item, pinned: on }), on ? "已置顶" : "已取消置顶");
    }

    if (intent.type === "clear-done") {
      if (intent.confirm !== true && intent.confirm !== "true") {
        return { ok: false, note: "需要显式 confirm: true 才会清理，状态未改变" };
      }
      return await serialize(async () => {
        const index = await readIndex(ctx);
        const done = index.filter((entry) => entry.done).slice(0, CLEAR_LIMIT);
        if (done.length === 0) return { ok: true, state: await snapshot(ctx), note: "没有已完成记录" };
        const removed = new Set(done.map((entry) => entry.id));
        for (const id of removed) await ctx.cap.store.drop(`${ITEM_PREFIX}${id}`);
        await ctx.cap.store.write(
          INDEX_KEY,
          index.filter((entry) => !removed.has(entry.id)),
        );
        return { ok: true, state: await snapshot(ctx), note: `已清理 ${done.length} 条已完成记录` };
      });
    }

    return { ok: false, note: `未知动作: ${intent.type}` };
  },
};
