import * as fs from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cloudBuildTrigger } from "@globalhost/adapter-cloud-build-trigger";
import {
  createRegistry,
  MAX_FACTORY_YAML_BYTES,
  parseFactoryYaml,
  validateFactoryConfig,
  type DeployAdapter,
  type FactoryYamlError,
  type Profile,
  type Registry,
} from "@globalhost/core";
import { webApp } from "@globalhost/profile-web-app";

const USAGE = `Usage: globalhost <command> [options]

Commands:
  validate [path]  Check a factory.yaml (default ./factory.yaml) against docs/FACTORY-YAML.md
                   Exit codes: 0 valid, 1 invalid, 2 usage error or unreadable file
  assess <repo>    Assess a repo for onboarding; writes the onboarding issue (globalhost assess --help)
  run              Run a factory role on an issue from this machine (globalhost run --help)
  roles sync       Create or update the role agents in Managed Agents

Options:
  --json         validate: print {"ok": bool, "errors": [{path, code, message}]}
  -h, --help     Show this help
  -v, --version  Show the CLI version`;

// C0/C1 control characters (incl. ESC) let echoed text rewrite the terminal; show them as \uXXXX instead.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export function printable(text: string): string {
  return text.replace(CONTROL_CHARS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The file-system calls `validate` makes; injectable so tests can prove what is (not) read. */
export interface FileIo {
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): { isFile(): boolean; size: number };
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  closeSync(fd: number): void;
}

export interface CliDeps {
  /**
   * Profiles and adapters `validate` checks against. The CLI, not core, is where they are imported
   * (FACTORY-YAML §7).
   */
  registry: Registry;
  io: FileIo;
}

/** Every profile and adapter the factory knows. Adding one is a package plus an entry here; core doesn't change. */
export const PROFILES: readonly Profile[] = [webApp];
const ADAPTERS: readonly DeployAdapter[] = [cloudBuildTrigger];

/** The factory checkout this CLI runs from (src/ and dist/ are both three levels down). */
const FACTORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Every registered profile's skill directory. Agents always carry all of them, so the agent definition is the
 * same for every caller; a skill loads only when its description fits the task.
 */
export const SKILL_DIRS: readonly string[] = [...new Set(PROFILES.flatMap((p) => p.skills.map((s) => resolve(FACTORY_ROOT, s.path))))];

export function defaultDeps(): CliDeps {
  return { registry: createRegistry(PROFILES, ADAPTERS), io: fs };
}

function readVersion(): string {
  // ../package.json resolves the same from src/ (tests) and dist/ (built CLI).
  const raw: unknown = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (typeof raw === "object" && raw !== null && "version" in raw && typeof raw.version === "string") {
    return raw.version;
  }
  throw new Error("packages/cli/package.json has no version");
}

const usageError = (message: string): CliResult => ({ code: 2, stdout: "", stderr: `${printable(message)}\n\n${USAGE}\n` });

export function run(argv: readonly string[], deps: Partial<CliDeps> = {}): CliResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        json: { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    return usageError((err as Error).message);
  }

  const [command, ...rest] = parsed.positionals;
  if (parsed.values.version) return { code: 0, stdout: `${readVersion()}\n`, stderr: "" };
  if (parsed.values.json && command !== "validate") return usageError("--json is only valid with validate");
  if (parsed.values.help || command === undefined) return { code: 0, stdout: `${USAGE}\n`, stderr: "" };

  if (command === "validate") {
    if (rest.length > 1) return usageError(`validate takes at most one path, got ${rest.length}`);
    return validate(rest[0] ?? "factory.yaml", parsed.values.json === true, { ...defaultDeps(), ...deps });
  }
  return { code: 2, stdout: "", stderr: `Unknown command: ${printable(command ?? "")}\n\n${USAGE}\n` };
}

type ReadOutcome = { kind: "bytes"; bytes: Uint8Array } | { kind: "too-large" } | { kind: "failed"; message: string };

/**
 * Opens the file once, checks with fstat that it's a regular file within the size cap, and only then reads,
 * stopping at cap + 1 bytes (the file may grow between fstat and read). O_NONBLOCK keeps a FIFO from hanging open().
 */
function readFactoryFile(path: string, io: FileIo): ReadOutcome {
  let fd: number;
  try {
    fd = io.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { kind: "failed", message: code === "ENOENT" ? "no such file" : `cannot open (${code ?? "error"})` };
  }
  try {
    const stat = io.fstatSync(fd);
    if (!stat.isFile()) return { kind: "failed", message: "not a regular file" };
    if (stat.size > MAX_FACTORY_YAML_BYTES) return { kind: "too-large" };
    const buffer = new Uint8Array(MAX_FACTORY_YAML_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const n = io.readSync(fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
    }
    if (total > MAX_FACTORY_YAML_BYTES) return { kind: "too-large" };
    return { kind: "bytes", bytes: buffer.subarray(0, total) };
  } catch (err) {
    return { kind: "failed", message: `cannot read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  } finally {
    io.closeSync(fd);
  }
}

function validate(path: string, json: boolean, deps: CliDeps): CliResult {
  const read = readFactoryFile(path, deps.io);
  if (read.kind === "failed") return { code: 2, stdout: "", stderr: `${printable(path)}: ${read.message}\n` };

  let errors: FactoryYamlError[] = [];
  if (read.kind === "too-large") {
    errors = [{ path: "", code: "yaml_too_large", message: `file is larger than ${MAX_FACTORY_YAML_BYTES} bytes` }];
  } else {
    const parsed = parseFactoryYaml(read.bytes);
    if (!parsed.ok) errors = parsed.errors;
    else {
      const result = validateFactoryConfig(parsed.value, deps.registry);
      if (!result.ok) errors = result.errors;
    }
  }

  const ok = errors.length === 0;
  if (json) {
    // JSON.stringify escapes C0 controls; printable() then turns DEL/C1 into \u00XX, still valid JSON escapes.
    return { code: ok ? 0 : 1, stdout: `${printable(JSON.stringify({ ok, errors }))}\n`, stderr: "" };
  }
  const file = printable(path);
  if (ok) return { code: 0, stdout: `${file}: valid\n`, stderr: "" };
  const lines = errors.map((e) => `${e.path === "" ? file : printable(e.path)}: ${printable(e.message)}`);
  const summary = `${file}: ${errors.length} error${errors.length === 1 ? "" : "s"}`;
  return { code: 1, stdout: `${[...lines, summary].join("\n")}\n`, stderr: "" };
}
