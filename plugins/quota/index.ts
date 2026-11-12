import { KilnError } from "#grain";
import { definePlugin, type Middleware } from "#host";

export interface QuotaOptions {
  /** 每分钟允许的调用次数。 */
  readonly callsPerMinute: number;
  /** 每个 cast 单独计数，还是全局一个桶。 */
  readonly perCast?: boolean;
}

/**
 * 示例插件：调用配额。
 *
 * 它存在的意义不是配额本身，而是证明「计费 / 限流 / 审计」这类横切能力
 * 可以完全不碰内核——只用中间件就能挂上，而且换一个宿主可以换一套实现。
 */
export function quotaPlugin(options: QuotaOptions) {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const middleware: Middleware = (next) => async (event) => {
    const key = options.perCast === false ? "*" : event.castId;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
    } else {
      bucket.count += 1;
      if (bucket.count > options.callsPerMinute) {
        throw new KilnError({
          code: "KILN_CAP_DENIED",
          message: `超出配额: ${key} 每分钟 ${options.callsPerMinute} 次`,
          hint: "等窗口重置，或换一个更宽的配额档位。",
          detail: {
            bucket: key,
            limit: options.callsPerMinute,
            retryAfterMs: bucket.resetAt - now,
          },
        });
      }
    }
    return next(event);
  };

  return definePlugin({
    name: "kiln.plugin.quota",
    setup(api) {
      api.addMiddleware(middleware);
    },
  });
}
