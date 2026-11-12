import { specFor } from "./codes.ts";

/** 错误说明统一指向仓库内中文文档，随源码分发，永远有效。 */
export const DOC_BASE = "docs/ERRORS.md#";

export interface Issue {
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  readonly docs: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly detail?: Record<string, unknown>;
}

/** 与 GitHub 标题锚点规则一致：转小写、保留下划线，不替换成连字符。 */
export function docFor(code: string): string {
  return DOC_BASE + code.toLowerCase();
}

export interface IssueInput {
  code: string;
  message?: string;
  hint?: string;
  file?: string;
  line?: number;
  column?: number;
  detail?: Record<string, unknown>;
}

/**
 * 构造一条 issue。message 省略时取该码的 title，hint 省略时取登记表里的默认建议。
 * 单一入口保证所有错误形状一致，这是 agent 能可靠解析错误的前提。
 */
export function issue(input: IssueInput): Issue {
  const spec = specFor(input.code);
  return {
    code: input.code,
    message: input.message ?? spec.title,
    hint: input.hint ?? spec.hint,
    docs: docFor(input.code),
    ...(input.file !== undefined ? { file: input.file } : {}),
    ...(input.line !== undefined ? { line: input.line } : {}),
    ...(input.column !== undefined ? { column: input.column } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };
}

export class KilnError extends Error {
  readonly issue: Issue;

  constructor(input: IssueInput) {
    const built = issue(input);
    super(`[${built.code}] ${built.message}`);
    this.name = "KilnError";
    this.issue = built;
  }

  /** 从已构造好的 issue 还原成异常。用于把记录下来的拒绝事件重新抛出。 */
  static fromIssue(built: Issue): KilnError {
    const restored = new KilnError({
      code: built.code,
      message: built.message,
      hint: built.hint,
      ...(built.file !== undefined ? { file: built.file } : {}),
      ...(built.line !== undefined ? { line: built.line } : {}),
      ...(built.detail !== undefined ? { detail: built.detail } : {}),
    });
    return restored;
  }

  get code(): string {
    return this.issue.code;
  }

  toJSON(): Issue {
    return this.issue;
  }

  /** 一行人类可读，agent 侧不要解析这个，用 --json。 */
  format(): string {
    const where = this.issue.file ? ` ${this.issue.file}${this.issue.line ? `:${this.issue.line}` : ""}` : "";
    return [
      `[${this.issue.code}] ${this.issue.message}${where}`,
      `  修复：${this.issue.hint}`,
      `  文档：${this.issue.docs}`,
    ].join("\n");
  }
}

export function isKilnError(value: unknown): value is KilnError {
  return value instanceof KilnError;
}

/** 把任意异常收敛成 Issue，避免非结构化错误泄漏到上层。 */
export function toIssue(error: unknown): Issue {
  if (error instanceof KilnError) return error.issue;
  const cause = error instanceof Error ? error.message : String(error);
  return issue({ code: "KILN_CALL_FAILED", detail: { cause } });
}
