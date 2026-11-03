// Node.js and Bun: which versions a JavaScript part asks for. Node follows what the product's CI actually runs,
// highest precedence first:
//   node: actions/setup-node `node-version` in the installed CI workflow (globalhost-ci.yml), when it is a version
//         (exact or partial, e.g. 20 or 20.11.1) → that step's `node-version-file`, read as a version file →
//         .nvmrc / .node-version (part directory, then each parent) → package.json engines.node
//   bun:  package.json packageManager "bun@<version>" → package.json engines.bun
// A source whose value isn't a plain version or range (an alias such as lts/*, an expression, junk) is skipped with
// a note, and the next source is tried.
import type { RepoSnapshot, ToolRequirement, Toolchain } from "@globalhost/core";
import { parse } from "yaml";
import { parseVersionRange } from "@globalhost/core";
import { ANY, npmRangeToCanonical, UNSATISFIABLE, type Converted } from "./ranges.js";
import { MAX_MANIFEST_CHARS, MAX_VERSION_FILE_CHARS, firstLine, isRecord, join, readCapped, readPackageJson, selfAndParents, stringAt } from "./read.js";

/** The factory-installed CI workflow (ONBOARDING); its setup-node step is what CI actually runs. */
export const CI_WORKFLOW = ".github/workflows/globalhost-ci.yml";
export const NODE_VERSION_FILES = [".nvmrc", ".node-version"] as const;
/** Where the sandbox installs a requested version: npm's `node` and `bun` packages fetch binaries from the registry. */
const PREFIX = "/tmp/toolchain";
/**
 * The `node` npm package (third-party, one maintainer) installs the platform binary in a preinstall script through
 * node-bin-setup; pinning that helper exactly keeps the only unpinned piece the binary package for the version asked
 * for. Accepted for the sandbox only (no credentials there); see ARCHITECTURE §2.4.
 */
export const NODE_BIN_SETUP = "node-bin-setup@1.1.4";

/** nvm / setup-node aliases: they move over time, so they pin nothing the harness can check. */
const NODE_ALIAS = /^(?:lts\/.*|lts|node|stable|latest|current|system|iojs)$/i;

const SETUP_NODE = /^actions\/setup-node@/;

export function nodeRequirement(range: string, source: string): ToolRequirement {
  return {
    tool: "node",
    range,
    source,
    check: "node --version",
    install: `npm install --prefix ${PREFIX}/node 'node@${range}' ${NODE_BIN_SETUP}, then start every later command with PATH="${PREFIX}/node/node_modules/.bin:$PATH"`,
  };
}

export function bunRequirement(range: string, source: string): ToolRequirement {
  return {
    tool: "bun",
    range,
    source,
    check: "bun --version",
    install: `npm install --prefix ${PREFIX}/bun 'bun@${range}', then start every later command with PATH="${PREFIX}/bun/node_modules/.bin:$PATH"`,
  };
}

function describe(path: string, value: Converted, raw: string, notes: string[]): string | undefined {
  if (typeof value === "string") return value;
  if (value === ANY) notes.push(`${path} accepts any version; not pinned`);
  else if (value === UNSATISFIABLE) notes.push(`${path} asks for a range no version satisfies; ignored`);
  else if (NODE_ALIAS.test(raw.trim())) notes.push(`${path} names an alias, not a version; ignored`);
  else notes.push(`${path} doesn't hold a version or range the harness accepts; ignored`);
  return undefined;
}

/**
 * setup-node's `node-version` and `node-version-file` values in a workflow, as raw strings (failsafe schema: every
 * scalar is a string). Undefined when the workflow isn't valid YAML.
 */
function setupNodeInputs(text: string): { versions: string[]; files: string[] } | undefined {
  let doc: unknown;
  try {
    doc = parse(text, { schema: "failsafe", maxAliasCount: 20, uniqueKeys: true });
  } catch {
    return undefined;
  }
  const out = { versions: [] as string[], files: [] as string[] };
  if (!isRecord(doc) || !isRecord(doc.jobs)) return out;
  for (const job of Object.values(doc.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (!isRecord(step) || typeof step.uses !== "string" || !SETUP_NODE.test(step.uses)) continue;
      const v = stringAt(step, "with", "node-version");
      if (v !== undefined) out.versions.push(v);
      const f = stringAt(step, "with", "node-version-file");
      if (f !== undefined) out.files.push(f);
    }
  }
  return out;
}

/** A plain repo-relative path (setup-node resolves node-version-file from the checkout root); undefined otherwise. */
function repoPath(raw: string): string | undefined {
  const p = raw.trim().replace(/^\.\//, "");
  if (!/^[A-Za-z0-9._@+/-]{1,200}$/.test(p) || p.startsWith("/") || p.split("/").some((s) => s === "" || s === "." || s === "..")) return undefined;
  return p;
}

/**
 * One version file (.nvmrc-style first line, or package.json engines.node) → a range, with notes. `label` names the
 * file in notes; callers pass fixed text when the path itself came from repo content.
 */
async function versionFile(repo: RepoSnapshot, path: string, notes: string[], label = path): Promise<string | undefined> {
  if (path === "package.json" || path.endsWith("/package.json")) {
    const { pkg } = await readPackageJson(repo, path);
    if (!pkg && repo.files.includes(path)) notes.push(`${label} isn't a readable JSON object; ignored`);
    const engines = stringAt(pkg, "engines", "node");
    return engines === undefined ? undefined : describe(`${label} engines.node`, npmRangeToCanonical(engines), engines, notes);
  }
  const r = await readCapped(repo, path, MAX_VERSION_FILE_CHARS);
  if (r.kind === "absent") return undefined;
  if (r.kind === "too-big") {
    notes.push(`${label} is too large to be a version file; ignored`);
    return undefined;
  }
  const line = firstLine(r.text);
  if (line === undefined) {
    notes.push(`${label} is empty; ignored`);
    return undefined;
  }
  return describe(label, npmRangeToCanonical(line), line, notes);
}

/** How notes name a setup-node node-version-file: its path is repo content, so it never appears in text. */
const VERSION_FILE_LABEL = `the node-version-file named in ${CI_WORKFLOW}`;

/** A single exact or partial version ("20", "20.11.1"): what setup-node installs as is. */
const isVersion = (range: string) => {
  const r = parseVersionRange(range);
  return r?.length === 1 && r[0]?.length === 1 && r[0][0]?.op === "=";
};

/** The CI workflow's setup-node: its node-version when that is a version, else its node-version-file. */
async function fromWorkflow(repo: RepoSnapshot, notes: string[]): Promise<{ range: string; source: string } | undefined> {
  const wf = await readCapped(repo, CI_WORKFLOW, MAX_MANIFEST_CHARS);
  if (wf.kind === "too-big") notes.push(`${CI_WORKFLOW} is too large to read; ignored`);
  if (wf.kind !== "ok") return undefined;
  const inputs = setupNodeInputs(wf.text);
  if (!inputs) {
    notes.push(`${CI_WORKFLOW} is not valid YAML; ignored`);
    return undefined;
  }
  const ranges = new Set<string>();
  let unreadVersion = false;
  for (const v of inputs.versions) {
    if (v.includes("${{")) {
      notes.push(`${CI_WORKFLOW} sets node-version from an expression; ignored`);
      unreadVersion = true;
    } else {
      const range = describe(`${CI_WORKFLOW} node-version`, npmRangeToCanonical(v), v, notes);
      if (range && isVersion(range)) ranges.add(range);
      else {
        if (range) notes.push(`${CI_WORKFLOW} node-version is a range, not a version; ignored`);
        unreadVersion = true;
      }
    }
  }
  const [only] = ranges;
  if (ranges.size === 1 && only) return { range: only, source: CI_WORKFLOW };
  if (ranges.size > 1) {
    notes.push(`${CI_WORKFLOW} sets different node-version values; none used`);
    return undefined;
  }
  const files = new Set<string>();
  for (const f of inputs.files) {
    const p = f.includes("${{") ? undefined : repoPath(f);
    if (p) files.add(p);
    else notes.push(`${CI_WORKFLOW} node-version-file isn't a plain repo path; ignored`);
  }
  if (files.size > 1) {
    notes.push(`${CI_WORKFLOW} names different node-version-file paths; none used`);
    return undefined;
  }
  const [file] = files;
  if (!file) return undefined;
  const range = await versionFile(repo, file, notes, VERSION_FILE_LABEL);
  if (range) {
    // setup-node prefers node-version when both are set; if that couldn't be read, CI may run something else.
    if (unreadVersion) notes.push(`${CI_WORKFLOW} also sets a node-version the harness couldn't read; CI may run a different version than ${VERSION_FILE_LABEL}`);
    // The source is the workflow itself: the file's path is repo content and stays out of the message.
    return { range, source: CI_WORKFLOW };
  }
  if (!repo.files.includes(file)) notes.push(`${VERSION_FILE_LABEL} isn't on the base commit; ignored`);
  return undefined;
}

/** Version sources other tools use that the harness doesn't read: noted, so a difference from CI is explainable. */
async function unreadSources(repo: RepoSnapshot, partPath: string, notes: string[]): Promise<void> {
  const pkgPath = join(partPath, "package.json");
  const { pkg } = await readPackageJson(repo, pkgPath);
  if (stringAt(pkg, "volta", "node") !== undefined) notes.push(`${pkgPath} volta.node isn't read; Volta users and CI may differ from the version used`);
  for (const dir of selfAndParents(partPath)) {
    const path = join(dir, ".tool-versions");
    if (repo.files.includes(path)) notes.push(`${path} isn't read; asdf/mise users may run a different version`);
  }
}

export async function detectNode(repo: RepoSnapshot, partPath: string): Promise<Toolchain> {
  const notes: string[] = [];
  const done = (range: string, source: string): Toolchain => ({ tools: [nodeRequirement(range, source)], notes });
  await unreadSources(repo, partPath, notes);

  const ci = await fromWorkflow(repo, notes);
  if (ci) return done(ci.range, ci.source);

  for (const dir of selfAndParents(partPath)) {
    for (const name of NODE_VERSION_FILES) {
      const path = join(dir, name);
      const range = await versionFile(repo, path, notes);
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
