import { parentPort, workerData } from "node:worker_threads";
import { toIssue } from "#grain";
import { loadCast } from "#pact";
import { CastRunner, LOCAL_POLICY, RELAXED_POLICY, STRICT_POLICY } from "#host";

interface SandboxInput {
  readonly castDir: string;
  readonly verb: "invoke" | "observe" | "act" | "describe";
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly policy: "local" | "relaxed" | "strict";
  readonly workspace: string;
  readonly dataDir: string;
  readonly timeoutMs: number;
}

const input = workerData as SandboxInput;
const policy = input.policy === "strict" ? STRICT_POLICY : input.policy === "relaxed" ? RELAXED_POLICY : LOCAL_POLICY;

const loaded = await loadCast({ dir: input.castDir });
if (!loaded.ok) {
  parentPort?.postMessage({ ok: false, issues: loaded.issues });
} else {
  const runner = new CastRunner({
    cast: loaded.cast,
    policy,
    paths: { dataDir: input.dataDir, workspace: input.workspace },
    timeoutMs: input.timeoutMs,
  });
  const started = Date.now();
  try {
    const value =
      input.verb === "describe"
        ? await runner.describe()
        : input.verb === "observe"
          ? (await runner.observe()).observation
          : input.verb === "act"
            ? (await runner.act({ ...input.args, type: input.name })).outcome
            : (await runner.invoke(input.name, input.args)).value;
    parentPort?.postMessage({ ok: true, value, ms: Date.now() - started });
  } catch (error) {
    parentPort?.postMessage({ ok: false, issues: [toIssue(error)], ms: Date.now() - started });
  }
}
