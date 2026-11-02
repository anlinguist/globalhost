// `globalhost dispatch <gate|run|observe>`: the steps of the installed workflows (P1-07, P1-12), run by
// packages/action inside a product repo's GitHub Actions job. Not meant for interactive use.
import { dispatchStep, gateStep, observeStep, writeOutputs } from "@globalhost/dispatch";
import { PROFILES, SKILL_DIRS, defaultDeps, printable } from "./main.js";

export async function dispatchCommand(argv: readonly string[], env: NodeJS.ProcessEnv, err: (t: string) => void): Promise<number> {
  const log = (line: string) => err(`${printable(line)}\n`);
  const deps = { env, registry: defaultDeps().registry, profiles: PROFILES, skillDirs: SKILL_DIRS, log };
  try {
    if (argv[1] === "gate" && argv.length === 2) {
      const out = await gateStep(deps);
      log(`gate: ${out.action}${out.reason ? ` (${out.reason})` : ""}`);
      if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is not set");
      await writeOutputs(env.GITHUB_OUTPUT, out);
      return 0;
    }
    if (argv[1] === "run" && argv.length === 2) {
      const record = await dispatchStep(deps);
      if (record) log(`run ${record.runId}: ${record.status}, $${record.costUsd.toFixed(2)}`);
      // A failed agent run is reported on GitHub; the job itself only fails on harness errors.
      return 0;
    }
    if (argv[1] === "observe" && argv.length === 2) {
      const out = await observeStep({ env, registry: deps.registry, log });
      log(`observe: ${out.outcome}`);
      // Red when any part's prod build failed, was cancelled or wasn't seen in time.
      return out.outcome === "failed" ? 1 : 0;
    }
    log("usage: globalhost dispatch <gate|run|observe>");
    return 2;
  } catch (e) {
    log(`error: ${(e as Error).message}`);
    return 1;
  }
}
