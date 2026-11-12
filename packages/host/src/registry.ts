import { KilnError } from "#grain";
import type { AgentAdapter } from "#pact";

export interface CapabilityDriver {
  readonly id: string;
  accepts(grant: unknown): boolean;
  /** 构造一个受限句柄。宿主只会把句柄交给这一次调用。 */
  open(grant: unknown, env: DriverEnv): unknown;
}

export interface DriverEnv {
  readonly root: string;
  readonly dataDir: string;
  readonly workspace: string;
}

export interface CheckHook {
  readonly id: string;
  run(input: {
    dir: string;
    manifest: unknown;
  }): Promise<{ code: string; message: string }[]> | { code: string; message: string }[];
}

export interface CallEvent {
  readonly castId: string;
  readonly verb: string;
  readonly name: string;
  readonly args: unknown;
}

export type CallNext = (event: CallEvent) => Promise<unknown>;
export type Middleware = (next: CallNext) => CallNext;

/**
 * 插件拿到的全部权力。故意做成白名单式的几个 add*，
 * 而不是「给你一个 host 对象随便改」——扩展点必须可枚举，否则边界就没了。
 */
export interface PluginApi {
  addAdapter(adapter: AgentAdapter): void;
  addCapability(driver: CapabilityDriver): void;
  addCheck(hook: CheckHook): void;
  addMiddleware(mw: Middleware): void;
  readonly hostVersion: string;
}

export interface KilnPlugin {
  readonly name: string;
  /** 声明它依赖的宿主版本区间，装载时校验。 */
  readonly requires?: string;
  setup(api: PluginApi): void | Promise<void>;
}

export function definePlugin(spec: KilnPlugin): KilnPlugin {
  return spec;
}

const HOST_VERSION = "0.1.0";

/**
 * 插件注册表。一个宿主一个实例，装载顺序即覆盖顺序（后装的适配器可覆盖同名）。
 * 任何一个插件失败都不会影响其余插件的贡献。
 */
export class Registry {
  readonly #adapters = new Map<string, AgentAdapter>();
  readonly #capabilities: CapabilityDriver[] = [];
  readonly #checks: CheckHook[] = [];
  readonly #middleware: Middleware[] = [];
  readonly #failures: { name: string; issue: unknown }[] = [];
  readonly #loaded: string[] = [];

  get adapters(): AgentAdapter[] {
    return [...this.#adapters.values()];
  }

  get capabilityDrivers(): CapabilityDriver[] {
    return [...this.#capabilities];
  }

  get checks(): CheckHook[] {
    return [...this.#checks];
  }

  get middleware(): Middleware[] {
    return [...this.#middleware];
  }

  get loaded(): string[] {
    return [...this.#loaded];
  }

  get failures(): { name: string; issue: unknown }[] {
    return [...this.#failures];
  }

  adapter(id: string): AgentAdapter {
    const found = this.#adapters.get(id);
    if (!found) {
      throw new KilnError({
        code: "KILN_ADAPTER_UNKNOWN",
        message: `未注册的适配器: ${id}`,
        detail: { requested: id, available: this.adapters.map((a) => a.id) },
      });
    }
    return found;
  }

  async use(plugin: KilnPlugin): Promise<void> {
    if (this.#loaded.includes(plugin.name)) {
      throw new KilnError({
        code: "KILN_PLUGIN_DUPLICATE",
        message: `插件重复装载: ${plugin.name}`,
        detail: { name: plugin.name },
      });
    }
    const api: PluginApi = {
      hostVersion: HOST_VERSION,
      addAdapter: (adapter) => {
        this.#adapters.set(adapter.id, adapter);
      },
      addCapability: (driver) => {
        if (!this.#capabilities.some((d) => d.id === driver.id)) this.#capabilities.push(driver);
      },
      addCheck: (hook) => {
        this.#checks.push(hook);
      },
      addMiddleware: (mw) => {
        this.#middleware.push(mw);
      },
    };
    try {
      await plugin.setup(api);
      this.#loaded.push(plugin.name);
    } catch (error) {
      this.#failures.push({ name: plugin.name, issue: error });
    }
  }

  /**
   * 把中间件串成一条调用链。装载顺序即包裹顺序：先装的在外层，后装的在内层，
   * 所以审计类中间件要最后装，才能记录到被配额拦下的调用。
   */
  compose(terminal: CallNext): CallNext {
    return this.#middleware.reduceRight<CallNext>((next, mw) => mw(next), terminal);
  }
}
