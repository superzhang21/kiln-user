import { readdir } from "node:fs/promises";
import path from "node:path";

export async function discoverCastDirs(root: string, maxDepth = 2): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "cast.json")) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }

  await walk(path.resolve(root), 0);
  return found.sort();
}
