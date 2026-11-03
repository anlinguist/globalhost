// Python and uv: which versions a Python part asks for. Sources, highest precedence first:
//   python: .python-version (part directory, then each parent) → pyproject.toml [project] requires-python
//   uv:     pyproject.toml [tool.uv] required-version → uv.toml required-version
// No profile uses these yet; the next one (a Python service) will, alongside detectBun for its web frontend.
import type { RepoSnapshot, ToolRequirement, Toolchain } from "@globalhost/core";
import { ANY, canonicalToPep440, pep440ToCanonical, UNSATISFIABLE, type Converted } from "./ranges.js";
import { MAX_MANIFEST_CHARS, MAX_VERSION_FILE_CHARS, firstLine, join, readCapped, selfAndParents, tomlString, type TomlLookup } from "./read.js";

const PREFIX = "/tmp/toolchain";
/** A CPython version in .python-version: "3.12" or "3.12.3". Interpreter names (pypy3.10, system) aren't. */
const PYTHON_VERSION_LINE = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5}))?$/;

export function pythonRequirement(range: string, source: string): ToolRequirement {
  return {
    tool: "python",
    range,
    source,
    // A uv-managed Python isn't put on python3, so check (and run) through uv, which picks it up.
    check: "uv run --no-project python --version",
    install: `uv python install '${canonicalToPep440(range)}', then run Python only through uv (uv run, uv sync)`,
  };
}

export function uvRequirement(range: string, source: string): ToolRequirement {
  return {
    tool: "uv",
    range,
    source,
    check: "uv --version",
    // Ubuntu's Python is externally managed (PEP 668) and may lack venv, so install to a target dir.
    install: `python3 -m pip install --break-system-packages --target ${PREFIX}/uv 'uv${canonicalToPep440(range)}', then start every later command with PATH="${PREFIX}/uv/bin:$PATH"`,
  };
}

function fromSpec(what: string, value: Converted, notes: string[]): string | undefined {
  if (typeof value === "string") return value;
  notes.push(
    value === ANY ? `${what} accepts any version; not pinned`
    : value === UNSATISFIABLE ? `${what} asks for a range no version satisfies; ignored`
    : `${what} isn't a specifier the harness accepts; ignored`,
  );
  return undefined;
}

async function readToml(repo: RepoSnapshot, path: string, table: string, key: string, notes: string[]): Promise<TomlLookup> {
  const r = await readCapped(repo, path, MAX_MANIFEST_CHARS);
  if (r.kind === "absent") return { kind: "absent" };
  if (r.kind === "too-big") {
    notes.push(`${path} is too large to read; ignored`);
    return { kind: "absent" };
  }
  const found = tomlString(r.text, table, key);
  if (found.kind === "invalid") notes.push(`${path} ${key} isn't a one-line string; ignored`);
  return found;
}

export async function detectPython(repo: RepoSnapshot, partPath: string): Promise<Toolchain> {
  const notes: string[] = [];
  for (const dir of selfAndParents(partPath)) {
    const path = join(dir, ".python-version");
    const r = await readCapped(repo, path, MAX_VERSION_FILE_CHARS);
    if (r.kind === "absent") continue;
    if (r.kind === "too-big") {
      notes.push(`${path} is too large to be a version file; ignored`);
      continue;
    }
    const line = firstLine(r.text);
    if (line !== undefined && PYTHON_VERSION_LINE.test(line)) return { tools: [pythonRequirement(line, path)], notes };
    notes.push(`${path} doesn't name a CPython version; ignored`);
  }
  const pyproject = join(partPath, "pyproject.toml");
  const req = await readToml(repo, pyproject, "project", "requires-python", notes);
  if (req.kind === "ok") {
    const range = fromSpec(`${pyproject} requires-python`, pep440ToCanonical(req.value), notes);
    if (range) return { tools: [pythonRequirement(range, pyproject)], notes };
  }
  return { tools: [], notes };
}

export async function detectUv(repo: RepoSnapshot, partPath: string): Promise<Toolchain> {
  const notes: string[] = [];
  for (const [path, table] of [[join(partPath, "pyproject.toml"), "tool.uv"], [join(partPath, "uv.toml"), ""]] as const) {
    const found = await readToml(repo, path, table, "required-version", notes);
    if (found.kind !== "ok") continue;
    const range = fromSpec(`${path} required-version`, pep440ToCanonical(found.value), notes);
    if (range) return { tools: [uvRequirement(range, path)], notes };
  }
  return { tools: [], notes };
}
