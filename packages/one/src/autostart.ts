import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KilnError } from "#grain";
import { cliPath } from "./bundle.ts";
import type { AutostartState, UpConfig } from "./types.ts";

export interface AutostartTarget {
  readonly platform: string;
  readonly path: string;
}

/** KILN_ONE_AUTOSTART_DIR 用于测试与自定义部署，避免写入真实用户启动目录。 */
export function autostartTarget(env: NodeJS.ProcessEnv = process.env): AutostartTarget {
  const platform = process.platform;
  const home = env.KILN_ONE_HOME ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  const override = env.KILN_ONE_AUTOSTART_DIR;
  const name =
    platform === "win32" ? "kiln-one.cmd" : platform === "darwin" ? "dev.kiln.one.plist" : "kiln-one.desktop";
  if (override) return { platform, path: path.join(override, name) };
  if (platform === "win32") {
    const base = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return { platform, path: path.join(base, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", name) };
  }
  if (platform === "darwin") return { platform, path: path.join(home, "Library", "LaunchAgents", name) };
  return { platform, path: path.join(home, ".config", "autostart", name) };
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function scriptFor(target: AutostartTarget, options: { bundleDir: string; runtimeRoot: string }): string {
  const node = process.execPath;
  const cli = cliPath(options.runtimeRoot);
  const bundle = options.bundleDir;
  const log = path.join(bundle, ".kiln", "autostart.log");
  if (target.platform === "win32") {
    return [
      "@echo off",
      `start "" /min ${quote(node)} ${quote(cli)} up ${quote(bundle)} --yes --json > ${quote(log)} 2>&1`,
      "",
    ].join("\r\n");
  }
  if (target.platform === "darwin") {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      "  <key>Label</key><string>dev.kiln.one</string>",
      "  <key>ProgramArguments</key><array>",
      `    <string>${node}</string><string>${cli}</string><string>up</string><string>${bundle}</string>`,
      "    <string>--yes</string><string>--json</string>",
      "  </array>",
      "  <key>RunAtLoad</key><true/>",
      `  <key>StandardOutPath</key><string>${log}</string>`,
      `  <key>StandardErrorPath</key><string>${log}</string>`,
      "</dict></plist>",
      "",
    ].join("\n");
  }
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Kiln One",
    `Exec=/bin/sh -c '${node} ${cli} up ${bundle} --yes --json > ${log} 2>&1'`,
    "X-GNOME-Autostart-enabled=true",
    "Terminal=false",
    "",
  ].join("\n");
}

export async function enableAutostart(options: {
  readonly bundleDir: string;
  readonly config: UpConfig;
  readonly runtimeRoot: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<AutostartState> {
  const target = autostartTarget(options.env ?? process.env);
  try {
    await mkdir(path.dirname(target.path), { recursive: true });
    await writeFile(target.path, scriptFor(target, options), "utf8");
  } catch (error) {
    throw new KilnError({
      code: "KILN_ONE_AUTOSTART",
      message: `写入开机自启项失败: ${target.path}`,
      hint: "检查目录权限，或用 KILN_ONE_AUTOSTART_DIR 指定一个可写目录；`kiln down` 可随时移除自启项。",
      detail: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
  void options.config;
  return { platform: target.platform, path: target.path, enabledAt: new Date().toISOString() };
}

export async function disableAutostart(state: AutostartState | null): Promise<boolean> {
  if (!state) return false;
  await rm(state.path, { force: true });
  return true;
}
