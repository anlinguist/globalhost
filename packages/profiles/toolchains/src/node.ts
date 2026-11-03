// Node.js and Bun: which versions a JavaScript part asks for. Sources, highest precedence first:
//   node: .nvmrc / .node-version (part directory, then each parent) → package.json engines.node → the
//         node-version of actions/setup-node in the installed CI workflow (globalhost-ci.yml)
//   bun:  package.json packageManager "bun@<version>" → package.json engines.bun
// A source whose value isn't a plain version or range (an alias such as lts/*, an expression, junk) is skipped with
// a note, and the next source is tried.
import type { RepoSnapshot, ToolRequirement, Toolchain } from "@globalhost/core";
import { parse } from "yaml";
import { ANY, npmRangeToCanonical, type Converted } from "./ranges.js";
import { MAX_MANIFEST_CHARS, MAX_VERSION_FILE_CHARS, firstLine, isRecord, join, readCapped, readPackageJson, selfAndParents, stringAt } from "./read.js";

/** The factory-installed CI workflow (ONBOARDING); its setup-node step is what CI actually runs. */
export const CI_WORKFLOW = ".github/workflows/globalhost-ci.yml";
export const NODE_VERSION_FILES = [".nvmrc", ".node-version"] as const;
/** Where the sandbox installs a requested version: npm's `node` and `bun` packages fetch binaries from the registry. */
const PREFIX = "/tmp/toolchain";

/** nvm / setup-node aliases: they move over time, so they pin nothing the harness can check. */
const NODE_ALIAS = /^(?:lts\/.*|lts|node|stable|latest|current|system|iojs)$/i;

const SETUP_NODE = /^actions\/setup-node@/;

export function nodeRequirement(range: string, source: string): ToolRequirement {
  return {
    tool: "node",
    range,
    source,
    check: "node --version",
    install: `npm install --prefix ${PREFIX}/node 'node@${range}' && export PATH="${PREFIX}/node/node_modules/.bin:$PATH"`,
  };
}

export function bunRequirement(range: string, source: string): ToolRequirement {
  return {
    tool: "bun",
    range,
    source,
    check: "bun --version",
    install: `npm install --prefix ${PREFIX}/bun 'bun@${range}' && export PATH="${PREFIX}/bun/node_modules/.bin:$PATH"`,
  };
}

function describe(path: string, value: Converted, raw: string, notes: string[]): string | undefined {
  if (typeof value === "string") return value;
  if (value === ANY) notes.push(`${path} accepts any version; not pinned`);
  else if (NODE_ALIAS.test(raw.trim())) notes.push(`${path} names an alias, not a version; ignored`);
  else notes.push(`${path} doesn't hold a version or range the harness accepts; ignored`);
  return undefined;
}

/** setup-node's node-version values in a workflow, as raw strings (failsafe schema: every scalar is a string). */
function setupNodeVersions(text: string): string[] | undefined {
  let doc: unknown;
  try {
    doc = parse(text, { schema: "failsafe", maxAliasCount: 20, uniqueKeys: true });
  } catch {
    return undefined;
  }
  if (!isRecord(doc) || !isRecord(doc.jobs)) return [];
  const out: string[] = [];
  for (const job of Object.values(doc.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (!isRecord(step) || typeof step.uses !== "string" || !SETUP_NODE.test(step.uses)) continue;
      const v = stringAt(step, "with", "node-version");
      if (v !== undefined) out.push(v);
    }
  }
  return out;
}

export async function detectNode(repo: RepoSnapshot, partPath: string): Promise<Toolchain> {
  const notes: string[] = [];
  const done = (range: string, source: string): Toolchain => ({ tools: [nodeRequirement(range, source)], notes });

  for (const dir of selfAndParents(partPath)) {
    for (const name of NODE_VERSION_FILES) {
      const path = join(dir, name);
      const r = await readCapped(repo, path, MAX_VERSION_FILE_CHARS);
      if (r.kind === "absent") continue;
      if (r.kind === "too-big") {
        notes.push(`${path} is too large to be a version file; ignored`);
        continue;
      }
      const line = firstLine(r.text);
      const range = line === undefined ? (notes.push(`${path} is empty; ignored`), undefined) : describe(path, npmRangeToCanonical(line), line, notes);
      if (range) return done(range, path);
    }
  }

  const pkgPath = join(partPath, "package.json");
  const { pkg, note } = await readPackageJson(repo, pkgPath);
  if (note) notes.push(note);
  const engines = stringAt(pkg, "engines", "node");
  if (engines !== undefined) {
    const range = describe(`${pkgPath} engines.node`, npmRangeToCanonical(engines), engines, notes);
    if (range) return done(range, pkgPath);
  }

  const wf = await readCapped(repo, CI_WORKFLOW, MAX_MANIFEST_CHARS);
  if (wf.kind === "too-big") notes.push(`${CI_WORKFLOW} is too large to read; ignored`);
  if (wf.kind === "ok") {
    const raw = setupNodeVersions(wf.text);
    if (raw === undefined) notes.push(`${CI_WORKFLOW} is not valid YAML; ignored`);
    else {
      const ranges = new Set<string>();
      for (const v of raw) {
        if (v.includes("${{")) notes.push(`${CI_WORKFLOW} sets node-version from an expression; ignored`);
        else {
          const range = describe(`${CI_WORKFLOW} node-version`, npmRangeToCanonical(v), v, notes);
          if (range) ranges.add(range);
        }
      }
      const [only] = ranges;
      if (ranges.size === 1 && only) return done(only, CI_WORKFLOW);
      if (ranges.size > 1) notes.push(`${CI_WORKFLOW} sets different node-version values; none used`);
    }
  }
  return { tools: [], notes };
}

/** bun@1.2.3, optionally followed by +<hash> (corepack's integrity suffix). */
const BUN_PACKAGE_MANAGER = /^bun@((?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2})(?:\+[A-Za-z0-9.]{1,200})?$/;

export async function detectBun(repo: RepoSnapshot, partPath: string): Promise<Toolchain> {
  const notes: string[] = [];
  const pkgPath = join(partPath, "package.json");
  const { pkg, note } = await readPackageJson(repo, pkgPath);
  if (note) notes.push(note);
  const pm = stringAt(pkg, "packageManager");
  if (pm !== undefined && pm.startsWith("bun@")) {
    const m = BUN_PACKAGE_MANAGER.exec(pm);
    if (m?.[1]) return { tools: [bunRequirement(m[1], pkgPath)], notes };
    notes.push(`${pkgPath} packageManager names bun without an exact version; ignored`);
  }
  const engines = stringAt(pkg, "engines", "bun");
  if (engines !== undefined) {
    const range = describe(`${pkgPath} engines.bun`, npmRangeToCanonical(engines), engines, notes);
    if (range) return { tools: [bunRequirement(range, pkgPath)], notes };
  }
  return { tools: [], notes };
}
