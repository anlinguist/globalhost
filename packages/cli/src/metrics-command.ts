// `globalhost metrics`: the nightly job (P1-13, ADR-0020), env-configured like `globalhost dispatch`. Its log is
// public: only fixed text and aggregate numbers go there, never an object name or an API path.
import { MetricsError, metricsStep } from "@globalhost/dispatch";
import { printable } from "./main.js";

export async function metricsCommand(argv: readonly string[], env: NodeJS.ProcessEnv, out: (t: string) => void, err: (t: string) => void): Promise<number> {
  const log = (line: string) => err(`${printable(line)}\n`);
  if (argv.length !== 1) {
    log("usage: globalhost metrics");
    return 2;
  }
  try {
    const { report } = await metricsStep({ env, log, out });
    for (const f of report.findings) log(`watcher: ${f.code}: ${f.message}`);
    return report.findings.length > 0 ? 1 : 0;
  } catch (e) {
    // Anything else could carry a private repo's name in its message, so only its type is shown.
    log(e instanceof MetricsError ? e.message : `metrics: unexpected ${(e as Error).name}`);
    return 1;
  }
}
