import type { Issue } from "#grain";

/** 一次携带全部问题，CLI 才能把所有失败原因同时输出。 */
export class OneIssues extends Error {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    super(issues.map((item) => `[${item.code}] ${item.message}`).join("; "));
    this.name = "OneIssues";
    this.issues = issues;
  }
}
