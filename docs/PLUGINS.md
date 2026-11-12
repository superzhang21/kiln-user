# 插件与接入

## 设计原则：扩展点必须可枚举

插件拿到的不是「一个 host 对象，随便改」，而是**四个 `add*` 方法**。

```ts
export interface PluginApi {
  addAdapter(adapter: AgentAdapter): void; // 让某类 agent 能读懂契约
  addCapability(driver: CapabilityDriver): void; // 新增一种能力（数据库、消息队列…）
  addCheck(hook: CheckHook): void; // 加校验规则
  addMiddleware(mw: Middleware): void; // 加横切逻辑（配额、审计、计费）
  readonly hostVersion: string; // 供插件做版本守卫
}
```

理由：给一个可变的 host 对象，扩展能力就没有边界，任何插件都能改任意状态；给四个 `add*`，内核知道全部可能的扩展形态，也就知道该在哪里设卡。

## 写一个插件

```ts
import { definePlugin } from "#host";

export const myPlugin = definePlugin({
  name: "acme.audit", // 全局唯一，重复装载会报 KILN_PLUGIN_DUPLICATE
  requires: ">=0.1.0", // 声明依赖的宿主版本
  setup(api) {
    api.addMiddleware((next) => async (event) => {
      console.error(`[audit] ${event.castId}.${event.name}`);
      return next(event);
    });
  },
});
```

装载：

```ts
const registry = await createRegistry([myPlugin]);
```

单个插件 `setup` 抛异常不会拖垮宿主：它会被记进 `registry.failures`，其余插件的贡献照常生效。

## 接入路径一：让某类 agent 读懂契约（`AgentAdapter`）

这是最常写的一类插件。它只做一件事：把同一份 `CastCatalog` 翻成某个 agent 生态能吃的形状。

```ts
export interface AgentAdapter {
  readonly id: string;
  readonly label: string;
  readonly produces: "tools" | "prompt" | "endpoint";
  readonly weight: number; // 体积系数，给调度器估算上下文成本
  expose(catalog: CastCatalog, options: ExposeOptions): Promise<AgentExposure>;
}
```

已内置两个，代表两条截然不同的路：

| 适配器  | `produces` | weight | 思路                                                          |
| ------- | ---------- | ------ | ------------------------------------------------------------- |
| `mcp`   | `tools`    | 1.0    | 标准 MCP `tools/list`，结构化、类型明确；stdio 服务覆盖四动词 |
| `brief` | `prompt`   | 0.45   | 压成一段提示词，一个工具一行加一条示例，体积不到一半          |

MCP 工具名按动词命名空间化：`<castId>__describe`、`<castId>__invoke__<tool>`、`<castId>__observe`、`<castId>__act__<action>`。通过 `kiln mcp <cast-or-apps-dir>` 启动 stdio 服务，既可指定单个 cast，也可指定包含多个 cast 的应用目录；通过 `kiln export --adapter mcp` 导出的则是静态工具清单。

`weight` 不是装饰。当你有几十个 cast、上下文放不下全量结构时，调度器要能在「结构精确但贵」和「文字粗糙但省」之间做选择。这个数字是那个决策的输入。

### 加一个新生态（以 ACP 为例）

```ts
export const acpAdapter: AgentAdapter = {
  id: "acp",
  label: "ACP session",
  produces: "endpoint",
  weight: 0.2,
  async expose(catalog) {
    return {
      adapter: "acp",
      kind: "endpoint",
      payload: { sessionHint: catalog.castId, note: "由宿主在 /acp 上暴露" },
      notes: ["不占上下文，靠端点发现"],
    };
  },
};
```

三个方法都不用改内核。这是把契约单独做一层的全部回报。

## 接入路径二：新增一种能力（`CapabilityDriver`）

清单类型允许声明六类能力（`shell` / `file` / `store` / `net` / `model` / `agent`）。前四类由内核直接提供；`model` 与 `agent` 由融合层提供可插拔离线驱动（见 `docs/FUSION.md`）。要加第七类——比如数据库、消息队列、内部 API——实现一个驱动：

```ts
export interface CapabilityDriver {
  readonly id: string;
  accepts(grant: unknown): boolean;
  open(grant: unknown, env: DriverEnv): unknown;
}

export const pgDriver: CapabilityDriver = {
  id: "pg",
  accepts: (grant) => typeof grant === "object" && grant !== null,
  open: (grant, env) => ({
    // 返回给 cast 的句柄。宿主只会把它交给这一次调用。
    query: async (sql: string) => {
      /* ... */
    },
  }),
};
```

要点：**驱动返回的是句柄，不是连接**。cast 永远拿不到能绕过策略的原对象。

## 接入路径三：横切逻辑（`Middleware`）

中间件是 `(next) => (event) => result` 的洋葱模型，只能看到 `{ castId, verb, name, args }`，改不了业务返回值。

`plugins/quota` 是一个完整可用的例子——调用配额：

```ts
const registry = await createRegistry([quotaPlugin({ callsPerMinute: 100 })]);
```

**计费、限流、审计、trace 全部挂这里。** 这也是为什么内核里没有一行计费代码：不是没做，是它本来就不该在核心里。

> 注意顺序：`registry.compose()` 按装载顺序从外到内包裹。审计类中间件应该最后装（最内层），这样它能记录到被配额拦下的调用。

## 接入路径四：加校验（`CheckHook`）

`CheckHook` 只在 `kiln check` 阶段跑，不参与运行时：

```ts
api.addCheck({
  id: "acme.naming",
  run: ({ manifest }) => [{ code: "ACME_NAMING", message: "..." }],
});
```

适合团队内规：命名前缀、必须声明的 owner、禁止的能力组合。

## 三层接入对照

| 你想做的事                                     | 用哪个扩展点    | 要不要动内核                   |
| ---------------------------------------------- | --------------- | ------------------------------ |
| 让 Claude Code / Cursor / 自研 agent 能调 cast | `addAdapter`    | 不要                           |
| 让 cast 能访问数据库、内部 API                 | `addCapability` | 不要                           |
| 加配额、计费、审计                             | `addMiddleware` | 不要                           |
| 加团队规约检查                                 | `addCheck`      | 不要                           |
| 改四动词语义                                   | ——              | **要，而且应该先质疑这个需求** |

最后一行是刻意的门槛。四动词是这套东西的地基，插件系统再好也不让插件去动它。

## 一个不推荐的做法

不要把「某个具体业务」写成插件。插件是**机制**层面的扩展（新的 agent 协议、新的能力类型、新的横切关注点）。业务逻辑属于 cast。混淆这两者的后果是：插件系统会慢慢长成一个没人敢动的巨型框架，而 cast 变成它的配置文件。

上游项目里已经有这个味道了——扩展点一多，边界就模糊。这里只留四个，就是为了不给它发生的机会。
