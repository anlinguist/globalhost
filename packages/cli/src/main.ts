import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const USAGE = `Usage: globalhost <command> [options]

Options:
  -h, --help     Show this help
  -v, --version  Show the CLI version

Commands are added as their PLAN.md issues land (validate: P1-02).`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function readVersion(): string {
  // ../package.json resolves the same from src/ (tests) and dist/ (built CLI).
  const raw: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (typeof raw === "object" && raw !== null && "version" in raw && typeof raw.version === "string") {
    return raw.version;
  }
  throw new Error("packages/cli/package.json has no version");
}

export function run(argv: readonly string[]): CliResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    return { code: 2, stdout: "", stderr: `${(err as Error).message}\n\n${USAGE}\n` };
  }

  if (parsed.values.version) return { code: 0, stdout: `${readVersion()}\n`, stderr: "" };
  if (parsed.values.help || parsed.positionals.length === 0) return { code: 0, stdout: `${USAGE}\n`, stderr: "" };

  return { code: 2, stdout: "", stderr: `Unknown command: ${parsed.positionals[0]}\n\n${USAGE}\n` };
}
