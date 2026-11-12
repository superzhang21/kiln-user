import os from "node:os";
import path from "node:path";

/**
 * 运行环境探测层。
 *
 * 这一层只做一件事：把「当前跑在什么系统、什么 Node、什么 shell」变成一份
 * 稳定、可测试、可序列化的快照，让上层不必到处写 `process.platform === "win32"`。
 * 它不依赖任何外部包，也不碰业务逻辑。
 */

export type OsKind = "windows" | "macos" | "linux" | "other";

/** 最低支持的 Node 版本，与 package.json 的 engines 保持一致。 */
export const MIN_NODE = { major: 22, minor: 18 } as const;

export interface RuntimeInfo {
  readonly os: OsKind;
  readonly arch: string;
  readonly node: string;
  readonly supported: boolean;
  readonly requirement: string;
  readonly shell: string;
  readonly isWindows: boolean;
  readonly home: string;
  readonly temp: string;
  readonly pathSeparator: string;
}

export function detectOs(platform: string = process.platform): OsKind {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "other";
}

/** 解析 Node 版本；任何残缺或非法输入都退化成 0.0.0，绝不抛错。 */
export function parseNodeVersion(version: string): { major: number; minor: number; patch: number } {
  const parts = version.split(".");
  const major = Number.parseInt(parts[0] ?? "0", 10);
  const minor = Number.parseInt(parts[1] ?? "0", 10);
  const patch = Number.parseInt(parts[2] ?? "0", 10);
  return {
    major: Number.isFinite(major) ? major : 0,
    minor: Number.isFinite(minor) ? minor : 0,
    patch: Number.isFinite(patch) ? patch : 0,
  };
}

/** 判断版本是否满足 >=22.18。 */
export function isSupportedNode(version: string): boolean {
  const { major, minor } = parseNodeVersion(version);
  if (major > MIN_NODE.major) return true;
  if (major < MIN_NODE.major) return false;
  return minor >= MIN_NODE.minor;
}

/** 探测默认 shell：Windows 用 ComSpec，类 Unix 用 $SHELL，最后按平台兜底。 */
export function detectShell(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (platform === "win32") return env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
  if (env.SHELL) return env.SHELL;
  return platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

export interface DetectOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: string;
  readonly arch?: string;
  readonly nodeVersion?: string;
}

export function detectRuntime(options: DetectOptions = {}): RuntimeInfo {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  return {
    os: detectOs(platform),
    arch,
    node: nodeVersion,
    supported: isSupportedNode(nodeVersion),
    requirement: `>=${MIN_NODE.major}.${MIN_NODE.minor}`,
    shell: detectShell(env, platform),
    isWindows: platform === "win32",
    home: env.KILN_ONE_HOME ?? env.HOME ?? env.USERPROFILE ?? os.homedir(),
    temp: os.tmpdir(),
    pathSeparator: path.sep,
  };
}

/** 统一成 POSIX 风格斜杠，便于跨平台比较路径前缀或导出配置。 */
export function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

/** 判断归一化后的路径是否为绝对路径（兼容 Windows 盘符）。 */
export function isAbsolutePortable(value: string): boolean {
  const normalized = normalizePath(value);
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
}

/** 生成给人看的多行快照；`doctor` 命令直接用这个。 */
export function describeRuntime(info: RuntimeInfo = detectRuntime()): readonly string[] {
  return [
    `系统    ${info.os} (${info.arch})`,
    `Node    ${info.node}${info.supported ? "" : `  ✗ 需要 ${info.requirement}`}`,
    `Shell   ${info.shell}`,
    `主目录  ${info.home}`,
    `临时    ${info.temp}`,
  ];
}

export * from "./daemon.ts";
