// `globalhost dispatch <gate|run>`: the steps of the installed workflow (P1-07), run by
// packages/action inside a product repo's GitHub Actions job. Not meant for interactive use.
import { dispatchStep, gateStep, writeOutputs } from "@globalhost/dispatch";
import { defaultDeps, printable } from "./main.js";

export async function dispatchCommand(argv: readonly string[], env: NodeJS.ProcessEnv, err: (t: string) => void): Promise<number> {
  const log = (line: string) => err(`${printable(line)}\n`);
  const deps = { env, registry: defaultDeps().registry, log };
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
    log("usage: globalhost dispatch <gate|run>");
    return 2;
  } catch (e) {
    log(`error: ${(e as Error).message}`);
    return 1;
  }
}
