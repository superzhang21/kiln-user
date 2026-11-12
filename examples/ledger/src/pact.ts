import type { CastContext, CastPact } from "#pact";

const DEFAULT_FILE = "events.ndjson";
const KINDS = ["click", "view", "error"] as const;

function generator(rows: number): string {
  const out: string[] = [];
  for (let i = 0; i < rows; i += 1) {
    const kind = KINDS[i % KINDS.length] ?? "click";
    out.push(
      JSON.stringify({
        ts: 1_790_000_000_000 + i * 137,
        kind,
        actor: `u${(i * 7) % 53}`,
        path: `/repo/item/${i % 211}`,
        ms: (i * 13) % 900,
      }),
    );
  }
  return `${out.join("\n")}\n`;
}

/** 相对路径按 {castdata} 解析，绝对占位符原样透传。 */
function toTarget(file: string): string {
  return file.includes("{") ? file : `{castdata}/${file}`;
}

export const pact: CastPact = {
  describe() {
    return {
      id: "ledger",
      version: "0.1.0",
      title: "事件账本摘要",
      summary: "把大体积事件日志压成一份小摘要，避免把原文塞进上下文",
      shape: "task",
      intents: ["日志", "摘要", "事件统计", "上下文压缩"],
    };
  },

  async invoke(tool: string, args: Record<string, unknown>, ctx: CastContext): Promise<unknown> {
    if (tool === "seed") {
      const rows = typeof args.rows === "number" ? Math.min(Math.max(Math.floor(args.rows), 1), 5000) : 800;
      const text = generator(rows);
      await ctx.cap.file.write("{castdata}/events.ndjson", text);
      return { ok: true, rows, bytes: Buffer.byteLength(text, "utf8") };
    }

    if (tool === "digest") {
      const file = typeof args.file === "string" && args.file !== "" ? args.file : DEFAULT_FILE;
      const top = typeof args.top === "number" && args.top > 0 ? Math.floor(args.top) : 5;

      let text: string;
      try {
        text = await ctx.cap.file.read(toTarget(file));
      } catch (error) {
        // 文件不存在是可预期的情况：告诉调用方先 seed，而不是抛一个栈。
        return {
          ok: false,
          reason: `读不到 ${file}`,
          next: "先调用 seed 生成样例，或把 file 指向 {castdata} 下已存在的文件",
          cause: error instanceof Error ? error.message : String(error),
        };
      }

      const lines = text.split("\n").filter((line) => line.trim() !== "");
      const counts = new Map<string, number>();
      for (const line of lines) {
        let kind = "unknown";
        try {
          const parsed = JSON.parse(line) as { kind?: unknown };
          if (typeof parsed.kind === "string") kind = parsed.kind;
        } catch {
          kind = "malformed";
        }
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }

      const byKind = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, top)
        .map(([kind, count]) => ({ kind, count }));

      const summary = { rows: lines.length, byKind };
      const summaryBytes = Buffer.byteLength(JSON.stringify(summary), "utf8");
      const bytes = Buffer.byteLength(text, "utf8");

      return {
        ok: true,
        rows: lines.length,
        bytes,
        byKind,
        summaryBytes,
        ratio: bytes === 0 ? 0 : Math.round((summaryBytes / bytes) * 10_000) / 10_000,
      };
    }

    return { ok: false, reason: `未实现工具: ${tool}` };
  },
};
