/** 能力级审计事件：谁、在什么时候、碰了什么、结果是成功还是被拦。 */
export interface AuditRecord {
  readonly at: string;
  readonly castId: string;
  readonly capability: "shell" | "net" | "file" | "store";
  readonly method: string;
  readonly target: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly ms: number;
  readonly diff?: string;
}

const MAX_TARGET = 200;
const MAX_DIFF = 4_000;

export function clip(value: string, limit = MAX_TARGET): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…（已截断）`;
}

/**
 * 面向人类的极简行级 diff：只展示首个差异窗口与少量上下文，
 * 足够回答「Agent 到底改了哪几行」，不追求完整 patch。
 */
export function diffText(before: string, after: string, context = 2): string {
  if (before === after) return "";
  const left = before.split(/\r?\n/);
  const right = after.split(/\r?\n/);
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endLeft = left.length - 1;
  let endRight = right.length - 1;
  while (endLeft >= start && endRight >= start && left[endLeft] === right[endRight]) {
    endLeft -= 1;
    endRight -= 1;
  }
  const from = Math.max(0, start - context);
  const toLeft = Math.min(left.length, endLeft + 1 + context);
  const toRight = Math.min(right.length, endRight + 1 + context);
  const lines = [`@@ -${from + 1},${toLeft - from} +${from + 1},${toRight - from} @@`];
  for (let index = from; index < start; index += 1) lines.push(` ${left[index] ?? ""}`);
  for (let index = start; index <= endLeft; index += 1) lines.push(`-${left[index] ?? ""}`);
  for (let index = start; index <= endRight; index += 1) lines.push(`+${right[index] ?? ""}`);
  for (let index = endLeft + 1; index < toLeft; index += 1) lines.push(` ${left[index] ?? ""}`);
  const text = lines.join("\n");
  return text.length > MAX_DIFF ? `${text.slice(0, MAX_DIFF)}\n…（diff 已截断）` : text;
}
