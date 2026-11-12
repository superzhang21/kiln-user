import { briefAdapter, mcpAdapter } from "#pact";
import { Registry, definePlugin, type KilnPlugin } from "./registry.ts";

/**
 * 内核只带两个适配器：一个给结构化工具调用，一个给上下文吃紧的场景。
 * 其余一切（ACP、OpenAI tools、自定义生态）都靠外部插件加进来。
 */
export const defaultPlugin: KilnPlugin = definePlugin({
  name: "kiln.default",
  setup(api) {
    api.addAdapter(mcpAdapter);
    api.addAdapter(briefAdapter);
  },
});

export async function createRegistry(extra: readonly KilnPlugin[] = []): Promise<Registry> {
  const registry = new Registry();
  await registry.use(defaultPlugin);
  for (const plugin of extra) await registry.use(plugin);
  return registry;
}
