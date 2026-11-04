// `globalhost cleanup`: the nightly cleanup job (P1-13 slice 2, ADR-0020), env-configured like `globalhost metrics`.
// Its log is public: PR numbers, amounts and fixed text only, never an object name or an API path.
import { appendFile } from "node:fs/promises";
import { CleanupError, cleanupStep } from "@globalhost/dispatch";
import { printable } from "./main.js";

export async function cleanupCommand(argv: readonly string[], env: NodeJS.ProcessEnv, out: (t: string) => void, err: (t: string) => void): Promise<number> {
  const log = (line: string) => err(`${printable(line)}\n`);
  if (argv.length !== 1) {
    log("usage: globalhost cleanup");
    return 2;
  }
  try {
    const { report, markdown } = await cleanupStep({ env, log });
    out(markdown);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, markdown);
    if (report.overCap) log(`cleanup: over the cap: ${report.planned} changes planned; nothing was changed`);
    for (const f of report.failures) log(`cleanup: ${f}`);
    return report.overCap || report.failures.length > 0 ? 1 : 0;
  } catch (e) {
    // Anything else could carry a private repo's name in its message, so only its type is shown.
    log(e instanceof CleanupError ? e.message : `cleanup: unexpected ${(e as Error).name}`);
    return 1;
  }
}
