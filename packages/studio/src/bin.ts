#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startStudio } from "./server.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    port: { type: "string" },
    host: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  process.stdout.write("用法：kiln-studio [目录] [--port 4310] [--host 127.0.0.1]\n");
  process.exit(0);
}

const root = positionals[0] ?? ".";
const preferred = values.port ? Number(values.port) : 4310;

let studio;
let lastError: unknown;
for (let attempt = 0; attempt < 12; attempt += 1) {
  try {
    studio = await startStudio({
      root,
      port: preferred + attempt,
      ...(values.host ? { host: values.host } : {}),
    });
    break;
  } catch (error) {
    lastError = error;
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
  }
}

if (!studio) {
  process.stderr.write(`无法监听 ${preferred}–${preferred + 11}: ${String(lastError)}\n`);
  process.exit(1);
}

process.stdout.write(`Kiln Studio 已启动：${studio.url}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void studio.close().then(() => process.exit(0));
  });
}
