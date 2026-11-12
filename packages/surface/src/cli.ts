#!/usr/bin/env node
import { parseArgs } from "node:util";
import { rmSync } from "node:fs";
import path from "node:path";
import { KilnError, readManifest, toIssue, validateManifest, type Issue } from "#grain";
import { discoverCastDirs, loadCast, type LoadedCast } from "#pact";
import { CastRunner, LOCAL_POLICY, RELAXED_POLICY, STRICT_POLICY, createRegistry } from "#host";
import { forge } from "#forge";
import type { HostPolicy } from "#host";
import { serveMcp } from "./mcp.ts";

const HELP = `kiln — 面向 agent 的微应用运行时

上手
  kiln new    <dir> [--template minimal|toolkit|panel] [--name <id>] [--title <t>] [--force]
                                                  生成一个可直接 check 通过的 cast 项目
  kiln doctor                                     报告系统 / Node / 引擎可用性

契约与运行
  kiln check   <dir> [--static] [--json]
  kiln describe <dir> [--json]
  kiln invoke  <dir> <tool> [--args <json>] [--json]
  kiln observe <dir> [--json]
  kiln act     <dir> <intent> [--args <json>] [--json]
  kiln forge   <dir> [--out <dir>] [--json]
  kiln export  <dir> --adapter <mcp|brief> [--json]
  kiln mcp     <cast-or-apps-dir> [--policy <local|relaxed|strict>]
  kiln studio  [root] [--port <n>]
  kiln plugins [--json]

普通用户一键包
  kiln up          [bundle] [--yes] [--require-approval] [--autostart] [--dev]
                   [--clients <a,b>] [--runtime <dir>] [--json]
  kiln down        [bundle] [--json]
  kiln status      [bundle] [--json]
  kiln seal        [bundle] [--json]
  kiln permissions [bundle] --action <show|grant|revoke> [--json]
  kiln panel       [bundle] [--port <n>]

融合层（打包 / 宿主 / 隔离）
  kiln artifact <build|verify|import|sign> <path> [--out <path>] [--key <id>]
  kiln keygen [dir] --key-dir <dir>
  kiln install <file|url> [--key-dir <dir>] [--require-signature]
  kiln list | uninstall <id>
  kiln sandbox <dir> <tool> [--args <json>] [--timeout <ms>] [--memory <mb>]
  kiln audit [--limit <n>] [--json]
  kiln cast <init|check> <project-dir>
  kiln host <install|list|approve|deny|enable|disable|run|panel|audit|uninstall> [target]
  kiln mcp-http <apps-dir> [--port <n>] [--token <t>]
  kiln discover <query> [--dir <apps-dir>]
  kiln eval [--json]

独立运行与 agent 接入
  kiln agents <dir> [--format mcp|openai|plain]   导出任意 agent 可消费的工具描述
  kiln serve  <dir> [--port <n>] [--host <h>] [--token <t>]
              [--rate-limit <n>] [--concurrency <n>] [--timeout <ms>]
              [--detach] [--stop]
                                                  启动通用 HTTP 工具网关（任意语言可调）
                                                  后台运行：--detach；停止：--stop
  kiln code   <dir> --prompt <text> [--base-url <u>] [--model <m>] [--api-key <k>]
              [--engine auto|builtin|pi] [--max-turns <n>]
                                                  启用 coding agent（需 grants.agent.allow）

通用
  --policy <local|relaxed|strict>   授权档位，默认 local
  --quota  <n>                      每分钟调用上限（挂示例插件）
  --json                            输出单条 JSON 到 stdout，其余走 stderr
  --help                            显示本页

退出码  0 成功  1 有问题  2 用法错误
`;

function isJson(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

function emit(envelope: unknown): void {
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

function human(lines: readonly string[]): void {
  process.stdout.write(`${lines.join("\n")}\n`);
}

function failWith(issues: readonly Issue[], json: boolean, command: string): number {
  if (json) {
    emit({ ok: false, command, schemaVersion: 1, issues });
  } else {
    for (const item of issues) {
      process.stderr.write(`[${item.code}] ${item.message}\n  修复：${item.hint}\n  文档：${item.docs}\n`);
    }
  }
  return 1;
}

function policyFor(name: string): HostPolicy {
  if (name === "strict") return STRICT_POLICY;
  if (name === "relaxed") return RELAXED_POLICY;
  return LOCAL_POLICY;
}

function parseJsonArg(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new KilnError({ code: "KILN_USAGE", message: "--args 必须是 JSON 对象" });
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof KilnError) throw error;
    throw new KilnError({
      code: "KILN_USAGE",
      message: "--args 不是合法 JSON",
      detail: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const json = isJson(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.filter((a) => a !== "--json"),
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        static: { type: "boolean" },
        args: { type: "string" },
        adapter: { type: "string" },
        out: { type: "string" },
        policy: { type: "string" },
        quota: { type: "string" },
        workspace: { type: "string" },
        port: { type: "string" },
        runtime: { type: "string" },
        clients: { type: "string" },
        action: { type: "string" },
        yes: { type: "boolean" },
        dev: { type: "boolean" },
        autostart: { type: "boolean" },
        "require-approval": { type: "boolean" },
        "skip-handshake": { type: "boolean" },
        "skip-register": { type: "boolean" },
        key: { type: "string" },
        "key-dir": { type: "string" },
        tenant: { type: "string" },
        by: { type: "string" },
        reason: { type: "string" },
        verb: { type: "string" },
        name: { type: "string" },
        dir: { type: "string" },
        token: { type: "string" },
        isolated: { type: "boolean" },
        hardened: { type: "boolean" },
        "require-signature": { type: "boolean" },
        home: { type: "string" },
        sandbox: { type: "boolean" },
        timeout: { type: "string" },
        memory: { type: "string" },
        limit: { type: "string" },
        format: { type: "string" },
        host: { type: "string" },
        prompt: { type: "string" },
        model: { type: "string" },
        "base-url": { type: "string" },
        "api-key": { type: "string" },
        "max-turns": { type: "string" },
        engine: { type: "string" },
        template: { type: "string" },
        title: { type: "string" },
        force: { type: "boolean" },
        "rate-limit": { type: "string" },
        concurrency: { type: "string" },
        detach: { type: "boolean" },
        stop: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    const item = toIssue(error);
    return failWith([{ ...item, code: "KILN_USAGE" }], json, "usage");
  }

  const { values, positionals } = parsed;
  if (typeof values.tenant === "string") process.env.KILN_TENANT = values.tenant;
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return values.help ? 0 : 2;
  }

  const command = positionals[0] as string;
  const target = positionals[1] as string | undefined;
  const policy = policyFor(values.policy ?? "local");

  const registry = await createRegistry();
  if (values.quota) {
    const { quotaPlugin } = await import("../../../plugins/quota/index.ts");
    await registry.use(quotaPlugin({ callsPerMinute: Number(values.quota) }));
  }

  try {
    switch (command) {
      case "check": {
        if (!target)
          return failWith([{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message: "缺少目录" }], json, command);
        if (values.static) {
          const raw = await readManifest(path.resolve(target));
          const result = validateManifest(raw, { file: path.join(target, "cast.json") });
          if (result.issues.length > 0) return failWith(result.issues, json, command);
          if (json) {
            emit({ ok: true, command, schemaVersion: 1, static: true, cast: result.manifest });
          } else {
            human([`✓ 清单通过（未加载入口）: ${result.manifest?.id}`]);
          }
          return 0;
        }
        const loaded = await loadCast({ dir: target });
        if (!loaded.ok) return failWith(loaded.issues, json, command);
        const extra: Issue[] = [];
        for (const hook of registry.checks) {
          const found = await hook.run({ dir: loaded.cast.dir, manifest: loaded.cast.manifest });
          for (const f of found) {
            extra.push({
              code: f.code,
              message: f.message,
              hint: "由插件检查报出。",
              docs: "docs/PLUGINS.md",
            });
          }
        }
        if (extra.length > 0) return failWith(extra, json, command);
        if (json) {
          emit({
            ok: true,
            command,
            schemaVersion: 1,
            castId: loaded.cast.manifest.id,
            verbs: loaded.cast.manifest.verbs,
            cost: loaded.cast.catalog.cost,
            issues: [],
          });
        } else {
          human([
            `✓ ${loaded.cast.manifest.id}@${loaded.cast.manifest.version}`,
            `  动词  ${loaded.cast.manifest.verbs.join(" / ")}`,
            `  工具  ${loaded.cast.catalog.tools.length} 个，目录约 ${loaded.cast.catalog.cost.bytes} 字节`,
          ]);
        }
        return 0;
      }

      case "describe": {
        if (!target)
          return failWith([{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message: "缺少目录" }], json, command);
        const loaded = await loadCast({ dir: target });
        if (!loaded.ok) return failWith(loaded.issues, json, command);
        const runner = new CastRunner({
          cast: loaded.cast,
          policy,
          paths: dataPaths(loaded.cast.manifest.id, values.workspace ?? process.cwd()),
          registry,
        });
        const description = await runner.describe();
        emit({ ok: true, command, schemaVersion: 1, description, catalog: loaded.cast.catalog });
        return 0;
      }

      case "invoke": {
        const tool = positionals[2];
        if (!target || !tool) {
          return failWith(
            [{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message: "需要目录与工具名" }],
            json,
            command,
          );
        }
        const args = parseJsonArg(values.args);
        if (values.sandbox) {
          const { runSandboxed } = await import("#fusion");
          const policyName = values.policy === "strict" || values.policy === "relaxed" ? values.policy : "local";
          const result = await runSandboxed({
            castDir: target,
            verb: "invoke",
            name: tool,
            args,
            policy: policyName,
            workspace: values.workspace ?? process.cwd(),
            ...(values.timeout ? { timeoutMs: Number(values.timeout) } : {}),
            ...(values.memory ? { memoryMb: Number(values.memory) } : {}),
          });
          emit({ ok: result.ok, command, schemaVersion: 1, result: result.value, sandbox: result });
          return result.ok ? 0 : 1;
        }
        if (values.isolated) {
          const { invokeIsolated } = await import("#fusion");
          const isolated = await invokeIsolated({
            castDir: target,
            tool,
            args,
            runtimeRoot: path.resolve(process.cwd()),
            policy: String(values.policy ?? "local"),
            workspace: values.workspace ?? process.cwd(),
            tenant: typeof values.tenant === "string" ? values.tenant : "default",
            hardened: values.hardened === true,
          });
          emit({ ok: isolated.ok, command, schemaVersion: 1, result: isolated.value, isolated, stamp: isolated.stamp });
          return isolated.ok ? 0 : 1;
        }
        const loaded = await loadCast({ dir: target });
        if (!loaded.ok) return failWith(loaded.issues, json, command);
        const runner = new CastRunner({
          cast: loaded.cast,
          policy,
          paths: dataPaths(loaded.cast.manifest.id, values.workspace ?? process.cwd()),
          registry,
        });
        const result = await runner.invoke(tool, args);
        emit({ ok: true, command, schemaVersion: 1, result: result.value, stamp: result.stamp });
        return 0;
      }

      case "observe": {
        if (!target)
          return failWith([{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message: "缺少目录" }], json, command);
        const loaded = await loadCast({ dir: target });
        if (!loaded.ok) return failWith(loaded.issues, json, command);
        const runner = new CastRunner({
          cast: loaded.cast,
          policy,
          paths: dataPaths(loaded.cast.manifest.id, values.workspace ?? process.cwd()),
          registry,
        });
        const result = await runner.observe();
        emit({ ok: true, command, schemaVersion: 1, observation: result.observation, stamp: result.stamp });
        return 0;
      }

      case "act": {
        const intentName = positionals[2];
        if (!target || !intentName) {
          return failWith(
            [{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message: "需要目录与动作名" }],
            json,
            command,
          );
        }
        const loaded = await loadCast({ dir: target });
        if (!loaded.ok) return failWith(loaded.issues, json, command);
        const runner = new CastRunner({
          cast: loaded.cast,
          policy,
          paths: dataPaths(loaded.cast.manifest.id, values.workspace ?? process.cwd()),
          registry,
        });
        const args = parseJsonArg(values.args);
        const result = await runner.act({ ...args, type: intentName });
        emit({ ok: result.outcome.ok, command, schemaVersion: 1, outcome: result.outcome, stamp: result.stamp });
        return result.outcome.ok ? 0 : 1;
      }

      case "forge": {
        if (!target)
          return failWith([{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message: "缺少目录" }], json, command);
        const result = await forge({
          dir: target,
          ...(values.out ? { outDir: values.out } : {}),
          adapters: registry.adapters,
        });
        if (!result.ok) return failWith(result.issues, json, command);
        emit({ ok: true, command, schemaVersion: 1, batch: result.batch });
        return 0;
      }

      case "export": {
        if (!target)
          return failWith([{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message: "缺少目录" }], json, command);
        const loaded = await loadCast({ dir: target });
        if (!loaded.ok) return failWith(loaded.issues, json, command);
        const adapter = registry.adapter(values.adapter ?? "mcp");
        const exposure = await adapter.expose(loaded.cast.catalog, {});
        emit({ ok: true, command, schemaVersion: 1, adapter: adapter.id, exposure });
        return 0;
      }

      case "mcp": {
        if (!target) {
          process.stderr.write("用法错误: kiln mcp 需要 cast 或应用目录\n");
          return 2;
        }
        const castDirs = await discoverCastDirs(target, 4);
        if (castDirs.length === 0) {
          process.stderr.write(`[KILN_ENTRY_MISSING] ${path.resolve(target)} 下没有发现 cast.json\n`);
          return 1;
        }
        const loadedCasts: LoadedCast[] = [];
        const castIds = new Set<string>();
        for (const dir of castDirs) {
          const loaded = await loadCast({ dir });
          if (!loaded.ok) {
            for (const item of loaded.issues) {
              process.stderr.write(`[${item.code}] ${item.message}\n  修复：${item.hint}\n  文档：${item.docs}\n`);
            }
            continue;
          }
          const id = loaded.cast.manifest.id;
          if (castIds.has(id)) {
            process.stderr.write(`[KILN_MANIFEST_ID] 应用目录中有重复 cast id: ${id} (${dir})\n`);
            continue;
          }
          castIds.add(id);
          loadedCasts.push(loaded.cast);
        }
        if (loadedCasts.length === 0) return 1;
        const workspace = values.workspace ?? process.cwd();
        const casts = loadedCasts.map((cast) => ({
          catalog: cast.catalog,
          runner: new CastRunner({
            cast,
            policy,
            paths: dataPaths(cast.manifest.id, workspace),
            registry,
          }),
        }));
        await serveMcp({ casts });
        return 0;
      }

      case "studio": {
        const { startStudio } = await import("#studio");
        const studio = await startStudio({
          root: target ?? process.cwd(),
          ...(values.port ? { port: Number(values.port) } : {}),
        });
        process.stderr.write(`Kiln Studio 已启动：${studio.url}\n`);
        return 0;
      }

      case "up": {
        const { upBundle } = await import("#one");
        const report = await upBundle({
          bundle: target,
          ...(values.runtime ? { runtimeRoot: String(values.runtime) } : {}),
          ...(values.dev ? { dev: true } : {}),
          ...(values["require-approval"] && !values.yes ? { requireApproval: true } : {}),
          ...(values.autostart ? { autostart: true } : {}),
          ...(values.clients
            ? {
                clients: String(values.clients)
                  .split(",")
                  .map((item) => item.trim())
                  .filter((item) => item !== ""),
              }
            : {}),
          ...(values["skip-handshake"] ? { skipHandshake: true } : {}),
          ...(values["skip-register"] ? { skipRegister: true } : {}),
        });
        if (json) emit(report);
        else human([report.human, ...report.nextSteps.map((step) => `  ${step}`)]);
        return 0;
      }

      case "down": {
        const { downBundle } = await import("#one");
        const report = await downBundle(target);
        if (json) emit(report);
        else human([report.human, ...report.failed.map((item) => `  ${item.path}: ${item.cause}`)]);
        return 0;
      }

      case "status": {
        const { statusOf } = await import("#one");
        const report = await statusOf(target);
        if (json) emit(report);
        else human([report.human, ...report.permissionLines.map((line) => `  ${line}`)]);
        return 0;
      }

      case "seal": {
        const { sealCommand } = await import("#one");
        const report = await sealCommand(target);
        if (json) emit(report);
        else human([report.human]);
        return 0;
      }

      case "permissions": {
        const { permissionsCommand } = await import("#one");
        const report = await permissionsCommand(target, String(values.action ?? "show"));
        if (json) emit(report);
        else human([report.human, ...report.lines.map((line) => `  ${line}`)]);
        return 0;
      }

      case "panel": {
        const { startPanel } = await import("#one");
        const panel = await startPanel({
          bundle: target,
          ...(values.port ? { port: Number(values.port) } : {}),
          ...(values.runtime ? { runtimeRoot: String(values.runtime) } : {}),
        });
        process.stderr.write(`Kiln One 状态面板已启动：${panel.url}\n`);
        return 0;
      }

      case "plugins": {
        emit({
          ok: true,
          command,
          schemaVersion: 1,
          adapters: registry.adapters.map((a) => ({
            id: a.id,
            label: a.label,
            produces: a.produces,
            weight: a.weight,
          })),
          capabilities: registry.capabilityDrivers.map((d) => d.id),
          checks: registry.checks.map((c) => c.id),
          middleware: registry.middleware.length,
          loaded: registry.loaded,
          failures: registry.failures,
        });
        return 0;
      }

      case "artifact":
      case "keygen":
      case "install":
      case "uninstall":
      case "list":
      case "sandbox":
      case "audit":
      case "cast":
      case "host":
      case "discover":
      case "eval":
      case "mcp-http": {
        const fusion = await import("#fusion/cli");
        const v = values as unknown as Record<string, string | boolean | undefined>;
        switch (command) {
          case "artifact":
            emit(await fusion.artifactCommand(positionals[1], positionals[2], v));
            break;
          case "keygen":
            emit(await fusion.keygenCommand(positionals[1], v));
            break;
          case "cast":
            emit(await fusion.castCommand(positionals[1], positionals[2], v));
            break;
          case "host":
            emit(await fusion.hostCommand(positionals[1], positionals[2], v));
            break;
          case "install":
            emit(await fusion.installCommand(positionals[1], v));
            break;
          case "uninstall":
            emit(await fusion.uninstallCommand(positionals[1], v));
            break;
          case "list":
            emit(await fusion.listCommand(v));
            break;
          case "sandbox":
            emit(await fusion.sandboxCommand(positionals[1], positionals[2], v));
            break;
          case "audit":
            emit(await fusion.auditCommand(v));
            break;
          case "discover":
            emit(await fusion.discoverCommand(positionals[1], v));
            break;
          case "eval":
            emit(await fusion.evalCommand());
            break;
          case "mcp-http":
            await fusion.mcpHttpCommand(positionals[1], v);
            break;
        }
        return 0;
      }

      case "new": {
        if (!target)
          return failWith(
            [{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message: "缺少项目目录，例如 kiln new my-app" }],
            json,
            command,
          );
        const { newCommand } = await import("#fusion/cli");
        const result = await newCommand(target, values);
        if (json) emit(result);
        else {
          const files = (result.files as readonly string[]).map((file) =>
            path.relative(process.cwd(), file).split(path.sep).join("/"),
          );
          human([
            `✓ 已生成 cast（模板 ${String(result.template)}）`,
            "",
            ...files.map((file) => `  ${file}`),
            "",
            "下一步",
            ...(result.next as readonly string[]).map((line) => `  ${line}`),
          ]);
        }
        return 0;
      }

      case "doctor": {
        const { detectRuntime, describeRuntime } = await import("#platform");
        const info = detectRuntime();
        const { detectPi } = await import("#coding-agent");
        const pi = await detectPi();
        const engines = { builtin: true, pi: pi.available };
        if (json) emit({ ok: info.supported, command, schemaVersion: 1, runtime: info, engines });
        else
          human([
            ...describeRuntime(info),
            "",
            `引擎    builtin 可用 · pi ${pi.available ? "可用" : "未安装"}`,
            ...(pi.available ? [] : ["        安装 Pi 引擎：npm i -D @earendil-works/pi-agent-core"]),
          ]);
        return info.supported ? 0 : 1;
      }

      case "agents": {
        if (!target)
          return failWith([{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message: "缺少目录" }], json, command);
        const loaded = await loadCast({ dir: target });
        if (!loaded.ok) return failWith(loaded.issues, json, command);
        const { describeCatalog, describeFormats } = await import("#agents");
        const format = typeof values.format === "string" ? values.format : "plain";
        if (!(describeFormats() as readonly string[]).includes(format)) {
          return failWith(
            [
              {
                ...toIssue(new KilnError({ code: "KILN_USAGE" })),
                message: `未知格式: ${format}（可选 ${describeFormats().join(" / ")}）`,
              },
            ],
            json,
            command,
          );
        }
        const descriptors = describeCatalog(loaded.cast.catalog, format as "mcp" | "openai" | "plain");
        if (json) emit({ ok: true, command, schemaVersion: 1, format, descriptors });
        else process.stdout.write(`${JSON.stringify(descriptors, null, 2)}\n`);
        return 0;
      }

      case "serve": {
        if (!target) {
          process.stderr.write("用法错误: kiln serve 需要 cast 或应用目录\n");
          return 2;
        }
        if (values.detach && values.stop) {
          process.stderr.write("用法错误: --detach 与 --stop 不能同时使用\n");
          return 2;
        }
        const serveWorkspace = path.resolve(typeof values.workspace === "string" ? values.workspace : process.cwd());
        const {
          serveStatePath,
          serveLogPath,
          readServeState,
          writeServeState,
          clearServeState,
          stopProcess,
          spawnDetached,
          waitForFile,
          isProcessAlive,
        } = await import("#platform");
        const stateFile = serveStatePath(serveWorkspace, target);

        if (values.stop) {
          const state = await readServeState(stateFile);
          if (!state) {
            const message = `没有在跑的后台网关：${target}`;
            if (json) return failWith([{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message }], json, command);
            process.stderr.write(`${message}\n如确认是残留进程，可用 kiln serve <dir> --detach 重新启动。\n`);
            return 1;
          }
          const stopped = await stopProcess(state.pid);
          if (stopped) await clearServeState(stateFile);
          if (json) emit({ ok: stopped, command, action: "stop", pid: state.pid, url: state.url });
          else
            human([stopped ? `✓ 已停止 ${state.url}（pid ${state.pid}）` : `✗ 进程 ${state.pid} 未能退出，可手动结束`]);
          return stopped ? 0 : 1;
        }

        const castDirs = await discoverCastDirs(target, 4);
        if (castDirs.length === 0) {
          process.stderr.write(`[KILN_ENTRY_MISSING] ${path.resolve(target)} 下没有发现 cast.json\n`);
          return 1;
        }

        const forwarded: string[] = [];
        if (values.port) forwarded.push("--port", String(values.port));
        if (typeof values.host === "string") forwarded.push("--host", values.host);
        if (typeof values.token === "string") forwarded.push("--token", values.token);
        if (values["rate-limit"]) forwarded.push("--rate-limit", String(values["rate-limit"]));
        if (values.concurrency) forwarded.push("--concurrency", String(values.concurrency));
        if (values.timeout) forwarded.push("--timeout", String(values.timeout));

        if (values.detach) {
          const previous = await readServeState(stateFile);
          if (previous && isProcessAlive(previous.pid)) {
            const message = `该目录已有后台网关在跑：${previous.url}（pid ${previous.pid}）`;
            if (json) return failWith([{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message }], json, command);
            process.stderr.write(`${message}\n先执行 kiln serve ${target} --stop，或换一个 --port。\n`);
            return 1;
          }
          await clearServeState(stateFile);
          const logFile = serveLogPath(serveWorkspace, target);
          await spawnDetached({
            execPath: process.execPath,
            args: [
              ...process.execArgv,
              process.argv[1] as string,
              "serve",
              target,
              "--workspace",
              serveWorkspace,
              ...forwarded,
            ],
            cwd: process.cwd(),
            logFile,
          });
          const ready = await waitForFile(stateFile, 15_000);
          if (!ready) {
            const message = "后台进程 15 秒内没有就绪";
            if (json) return failWith([{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message }], json, command);
            process.stderr.write(`${message}，看日志：${logFile}\n`);
            return 1;
          }
          const state = await readServeState(stateFile);
          if (json) emit({ ok: true, command, action: "detach", ...state });
          else
            human([
              `✓ 网关已在后台运行：${state?.url ?? ""}`,
              `  pid    ${state?.pid ?? "-"}`,
              `  日志   ${logFile}`,
              `  停止   kiln serve ${target} --stop`,
            ]);
          return 0;
        }

        const loadedCasts: LoadedCast[] = [];
        const seen = new Set<string>();
        for (const dir of castDirs) {
          const loaded = await loadCast({ dir });
          if (!loaded.ok) {
            for (const item of loaded.issues) {
              process.stderr.write(`[${item.code}] ${item.message}\n  修复：${item.hint}\n`);
            }
            continue;
          }
          if (seen.has(loaded.cast.manifest.id)) continue;
          seen.add(loaded.cast.manifest.id);
          loadedCasts.push(loaded.cast);
        }
        if (loadedCasts.length === 0) return 1;
        const workspace = serveWorkspace;
        const casts = loadedCasts.map((cast) => ({
          catalog: cast.catalog,
          runner: new CastRunner({
            cast,
            policy,
            paths: dataPaths(cast.manifest.id, workspace),
            registry,
          }),
        }));
        const { createAgentBridge } = await import("#agents");
        const { serveHttpBridge } = await import("#agents/http");
        const handle = await serveHttpBridge({
          bridge: createAgentBridge(casts, "kiln-http"),
          ...(values.port ? { port: Number(values.port) } : {}),
          ...(typeof values.host === "string" ? { host: values.host } : {}),
          ...(typeof values.token === "string" ? { token: values.token } : {}),
          ...(values["rate-limit"] ? { rateLimitPerMinute: Number(values["rate-limit"]) } : {}),
          ...(values.concurrency ? { maxConcurrent: Number(values.concurrency) } : {}),
          ...(values.timeout ? { callTimeoutMs: Number(values.timeout) } : {}),
        });
        await writeServeState(stateFile, {
          schemaVersion: 1,
          pid: process.pid,
          url: handle.url,
          host: handle.host,
          port: handle.port,
          target: path.resolve(target),
          startedAt: new Date().toISOString(),
          logFile: serveLogPath(workspace, target),
        });
        const dropState = (): void => {
          try {
            rmSync(stateFile, { force: true });
          } catch {
            /* 退出阶段尽力而为 */
          }
        };
        process.once("exit", dropState);
        process.once("SIGINT", () => {
          dropState();
          process.exit(0);
        });
        process.once("SIGTERM", () => {
          dropState();
          process.exit(0);
        });

        process.stderr.write(`Kiln agent 网关已启动：${handle.url}\n`);
        process.stderr.write(
          `  GET  /health  /describe  /tools/list\n  POST /tools/call  {"name":"...","arguments":{}}\n`,
        );
        process.stderr.write(
          `  限额 ${handle.limits.rateLimitPerMinute} 次/分钟 · 并发 ${handle.limits.maxConcurrent} · 超时 ${handle.limits.callTimeoutMs}ms\n`,
        );
        return 0;
      }

      case "code": {
        if (!target)
          return failWith([{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message: "缺少目录" }], json, command);
        const prompt = typeof values.prompt === "string" ? values.prompt : "";
        if (prompt.trim() === "")
          return failWith(
            [{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message: "缺少 --prompt" }],
            json,
            command,
          );
        const loaded = await loadCast({ dir: target });
        if (!loaded.ok) return failWith(loaded.issues, json, command);
        if (loaded.cast.manifest.grants.agent?.allow !== true) {
          return failWith(
            [
              toIssue(
                new KilnError({
                  code: "KILN_CODING_AGENT",
                  message: "该 cast 未声明 grants.agent.allow",
                  hint: '在 cast.json 的 grants 里加 { "agent": { "allow": true } }，明确授权模型代理调用它的工具。',
                }),
              ),
            ],
            json,
            command,
          );
        }
        const baseUrl = typeof values["base-url"] === "string" ? values["base-url"] : process.env.KILN_MODEL_BASE_URL;
        const model = typeof values.model === "string" ? values.model : process.env.KILN_MODEL_NAME;
        if (!baseUrl || !model) {
          return failWith(
            [
              toIssue(
                new KilnError({
                  code: "KILN_CODING_AGENT",
                  message: "缺少模型端点",
                  hint: "用 --base-url 与 --model 指定任意 OpenAI 兼容端点（OpenAI / DeepSeek / Ollama / vLLM），或设置 KILN_MODEL_BASE_URL / KILN_MODEL_NAME。",
                }),
              ),
            ],
            json,
            command,
          );
        }
        const workspace = values.workspace ?? process.cwd();
        const runner = new CastRunner({
          cast: loaded.cast,
          policy,
          paths: dataPaths(loaded.cast.manifest.id, workspace),
          registry,
        });
        const engineName = typeof values.engine === "string" ? values.engine : "auto";
        if (!["auto", "builtin", "pi"].includes(engineName)) {
          return failWith(
            [
              {
                ...toIssue(new KilnError({ code: "KILN_USAGE" })),
                message: `未知引擎: ${engineName}（可选 auto / builtin / pi）`,
              },
            ],
            json,
            command,
          );
        }
        const { createAgentBridge } = await import("#agents");
        const { createEngine } = await import("#coding-agent");
        const engine = await createEngine({
          bridge: createAgentBridge([{ catalog: loaded.cast.catalog, runner }]),
          provider: {
            baseUrl,
            model,
            ...(typeof values["api-key"] === "string" ? { apiKey: values["api-key"] } : {}),
          },
          engine: engineName as "auto" | "builtin" | "pi",
          ...(values["max-turns"] ? { maxTurns: Number(values["max-turns"]) } : {}),
        });
        const result = await engine.run(prompt);
        if (json) emit({ ok: result.ok, command, schemaVersion: 1, result });
        else
          human([
            result.output,
            "",
            `引擎 ${result.engine} · 轮次 ${result.turns} · 工具调用 ${result.steps.length} · 停止原因 ${result.stoppedBy}`,
          ]);
        return result.ok ? 0 : 1;
      }

      default:
        return failWith(
          [{ ...toIssue(new KilnError({ code: "KILN_USAGE" })), message: `未知命令: ${command}` }],
          json,
          command,
        );
    }
  } catch (error) {
    if (command === "mcp") {
      const item = toIssue(error);
      process.stderr.write(`[${item.code}] ${item.message}\n  修复：${item.hint}\n  文档：${item.docs}\n`);
      return 1;
    }
    const { OneIssues } = await import("#one");
    if (error instanceof OneIssues) return failWith(error.issues, json, command);
    return failWith([toIssue(error)], json, command);
  }
}

/** 数据落点跟随 --workspace：一键包的数据必须留在包内，而不是当前进程目录。 */
function dataPaths(castId: string, workspace: string): { dataDir: string; workspace: string } {
  const root = path.resolve(workspace);
  const tenant = process.env.KILN_TENANT;
  const dataDir = tenant
    ? path.join(root, ".kiln", "tenants", tenant, "data", castId)
    : path.join(root, ".kiln", "data", castId);
  return { dataDir, workspace: root };
}

const code = await main(process.argv.slice(2));
process.exitCode = code;
