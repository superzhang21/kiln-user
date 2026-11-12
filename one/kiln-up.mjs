#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(process.env.KILN_HOME ?? path.resolve(here, ".."));
const cli = path.join(runtimeRoot, "packages", "surface", "src", "cli.ts");

if (!existsSync(cli)) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: false,
        command: "up",
        schemaVersion: 1,
        issues: [
          {
            code: "KILN_ONE_RUNTIME",
            message: `找不到 kiln 运行时: ${cli}`,
            hint: "设置 KILN_HOME 指向 kiln 仓库根目录，或把这个一键包放在仓库内的 one/ 目录。",
            docs: "docs/ERRORS.md#kiln_one_runtime",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  process.exit(1);
}

const incoming = process.argv.slice(2);
const has = (flag) => incoming.includes(flag);
const command = has("--status") ? "status" : has("--down") ? "down" : has("--panel") ? "panel" : "up";
const forwarded = incoming.filter((arg) => !["--status", "--down", "--panel"].includes(arg));
if (!forwarded.includes("--json")) forwarded.push("--json");

const result = spawnSync(process.execPath, [cli, command, here, ...forwarded], {
  stdio: "inherit",
  env: { ...process.env, KILN_ONE_BUNDLE: here },
});
process.exitCode = typeof result.status === "number" ? result.status : 1;
