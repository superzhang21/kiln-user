import { readFile } from "node:fs/promises";
import path from "node:path";
import { KilnError } from "./error.ts";

/**
 * 读清单。只做读取与解析，不做校验——校验永远是独立一步，
 * 这样一次失败能返回全部问题，而不是修一个再跑一次。
 */
export async function readManifest(dir: string): Promise<unknown> {
  const file = path.join(dir, "cast.json");
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new KilnError({
      code: "KILN_MANIFEST_UNREADABLE",
      message: `读不到或解析失败: ${file}`,
      file,
      detail: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}
