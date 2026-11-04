// The `dependency-change` guardrail (ADR-0015 §8): any dependency that is new, bumped, removed or re-resolved between
// base and head, transitive lockfile entries included. Everything read is untrusted repo content. Whatever can't be
// read, parsed or compared trips; it never passes.
//
// The lockfiles it parses are compared by content, not as text, so reordered keys and whitespace don't trip and any
// other difference does: a version, an integrity hash, a tarball URL on another host, a flag.
import { globMatch, type DiffCtx, type Guardrail, type GuardrailResult } from "@globalhost/core";
import { isScalar, parseDocument, visit } from "yaml";

/** About 35 times numu-know's lockfile (233 KB), and small enough to parse in seconds. */
export const MAX_LOCKFILE_CHARS = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 2_000_000;

const MANIFEST = "package.json";
const PARSED_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "bun.lock"];

/**
 * Files where any change at all trips, because this guardrail can't compare them (a binary lockfile, formats not parsed
 * here) or because they steer resolution without touching a lockfile entry (registry settings, install hooks, patches,
 * vendored packages, pnpm's catalogs and overrides). Python manifests are here too: `uv.lock` is TOML with no parser in
 * the factory yet, and `pyproject.toml` mixes dependencies with everything else.
 */
const OPAQUE_GLOBS = [
  "**/bun.lockb",
  "**/yarn.lock",
  "**/.yarnrc.yml",
  "**/.npmrc",
  "**/bunfig.toml",
  "**/.pnpmfile.cjs",
  "**/pnpm-workspace.yaml",
  "**/patches/**",
  "**/node_modules/**",
  "**/uv.lock",
  "**/poetry.lock",
  "**/Pipfile",
  "**/Pipfile.lock",
  "**/pyproject.toml",
  "**/requirements*.txt",
];

export const DEPENDENCY_CHANGE_GLOBS: readonly string[] = Object.freeze([`**/${MANIFEST}`, ...PARSED_LOCKFILES.map((f) => `**/${f}`), ...OPAQUE_GLOBS]);

/**
 * package.json fields that say nothing about what gets installed. An allowlist, so an unfamiliar field (`overrides`,
 * `resolutions`, `pnpm`, `workspaces`, `packageManager`, `trustedDependencies`…) trips rather than passes.
 *
 * `scripts` is on it deliberately. Scripts do run code in CI and in the image build, install hooks included, but so
 * does every source file and test in the same PR, and those don't trip either: this guardrail is about what comes from
 * outside the repo. A script is a readable line in the diff for the reviewer, in the repo's own code. If scripts should
 * escalate, that is a separate trigger on its own terms, not a side effect of this one.
 */
const NON_DEPENDENCY_FIELDS = new Set([
  "name",
  "version",
  "description",
  "keywords",
  "license",
  "licenses",
  "author",
  "contributors",
  "maintainers",
  "homepage",
  "repository",
  "bugs",
  "funding",
  "private",
  "scripts",
  "type",
  "main",
  "module",
  "types",
  "typings",
  "exports",
  "imports",
  "files",
  "bin",
  "man",
  "directories",
  "sideEffects",
  "browserslist",
  "engines",
]);
/** A lockfile's copy of the root manifest, which also records whether the root has an install script. */
const LOCK_ROOT_FIELDS = new Set([...NON_DEPENDENCY_FIELDS, "hasInstallScript"]);

class Unreadable extends Error {}

/** Own-property copy without some keys. Object.fromEntries defines properties, so it can't touch a prototype. */
const without = (obj: Record<string, unknown>, keys: ReadonlySet<string>) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.has(k)));

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Stable text of a value: keys sorted, depth and size bounded. Refuses keys that mean something else to another parser. */
function canonical(value: unknown, budget: { nodes: number }, depth = 0): string {
  if ((budget.nodes -= 1) < 0 || depth > MAX_DEPTH) throw new Unreadable();
  if (value === null || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, budget, depth + 1)).join(",")}]`;
  if (!isMap(value)) throw new Unreadable();
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) {
    // No real package uses these. `__proto__` is a pollution attempt; `<<` is a merge key to pnpm's parser and not to ours.
    if (key === "__proto__" || key === "<<") throw new Unreadable();
    parts.push(`${JSON.stringify(key)}:${canonical(value[key], budget, depth + 1)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Parses npm's JSON, bun's JSON-with-trailing-commas and pnpm's YAML with one strict parser, since YAML is a superset of
 * the other two. Refuses several documents (reported only above logLevel "silent"), aliases (expansion attacks) and
 * duplicate keys (parsers disagree on which one wins). The failsafe schema keeps scalars as written, so `1.0` and `1.00`
 * stay different. Duplicates are checked here because the library's `uniqueKeys` is quadratic in a map's size, and this
 * work is synchronous: the engine's timeout can't interrupt it.
 */
function parseStrict(text: string): Record<string, unknown> {
  if (text.length > MAX_LOCKFILE_CHARS) throw new Unreadable();
  const doc = parseDocument(text, { schema: "failsafe", uniqueKeys: false, logLevel: "error" });
  if (doc.errors.length > 0 || doc.warnings.length > 0) throw new Unreadable();
  visit(doc, {
    Alias() {
      throw new Unreadable();
    },
    Map(_key, map) {
      const seen = new Set<string>();
      for (const { key } of map.items) {
        if (!isScalar(key) || typeof key.value !== "string" || seen.has(key.value)) throw new Unreadable();
        seen.add(key.value);
      }
    },
  });
  const value: unknown = doc.toJS();
  if (!isMap(value)) throw new Unreadable();
  return value;
}

/** Each top-level field, and each entry of a top-level map, as key → stable text. */
function lockEntries(text: string, file: string): Map<string, string> {
  const raw = parseStrict(text);
  let doc = raw;
  if (file === "package-lock.json" || file === "npm-shrinkwrap.json") {
    doc = without(raw, new Set(["name", "version"]));
    if (isMap(doc.packages) && isMap(doc.packages[""])) doc.packages = { ...doc.packages, "": without(doc.packages[""], LOCK_ROOT_FIELDS) };
  } else if (file === "bun.lock" && isMap(doc.workspaces) && isMap(doc.workspaces[""])) {
    doc = { ...doc, workspaces: { ...doc.workspaces, "": without(doc.workspaces[""], LOCK_ROOT_FIELDS) } };
  }
  const budget = { nodes: MAX_NODES };
  const out = new Map<string, string>();
  for (const [section, value] of Object.entries(doc)) {
    if (section === "__proto__" || section === "<<") throw new Unreadable();
    if (!isMap(value)) {
      out.set(section, canonical(value, budget));
      continue;
    }
    for (const key of Object.keys(value)) {
      if (key === "__proto__" || key === "<<") throw new Unreadable();
      out.set(`${section}\u0000${key}`, canonical(value[key], budget));
    }
    if (Object.keys(value).length === 0) out.set(section, "{}");
  }
  return out;
}

/** A package name for the report, from an entry's key. */
function subject(entryKey: string): string {
  const cut = entryKey.indexOf("\u0000");
  if (cut === -1) return entryKey;
  const section = entryKey.slice(0, cut);
  const key = entryKey.slice(cut + 1);
  return section === "packages" || section === "snapshots" || section === "dependencies" ? key.replace(/^.*node_modules\//, "") || "(root)" : `${section}/${key || "(root)"}`;
}

interface Findings {
  added: Set<string>;
  removed: Set<string>;
  changed: Set<string>;
  /** Fixed-text reasons a file tripped without being compared. */
  uncompared: Set<string>;
}

function compareLockfile(base: string | undefined, head: string | undefined, file: string, f: Findings): void {
  if (base === undefined || head === undefined) {
    f.uncompared.add(base === undefined ? "a lockfile was added" : "a lockfile was deleted");
    return;
  }
  let before: Map<string, string>;
  let after: Map<string, string>;
  try {
    before = lockEntries(base, file);
    after = lockEntries(head, file);
  } catch {
    // Unreadable, or the parser's own failure on hostile input (a stack overflow on deep nesting): both mean the same.
    f.uncompared.add("a lockfile could not be parsed or is too large");
    return;
  }
  for (const [key, value] of after) {
    const old = before.get(key);
    if (old === undefined) f.added.add(subject(key));
    else if (old !== value) f.changed.add(subject(key));
  }
  for (const key of before.keys()) if (!after.has(key)) f.removed.add(subject(key));
}

function compareManifest(base: string | undefined, head: string | undefined, lockChanged: boolean, f: Findings): void {
  try {
    // A missing side has no dependency fields, so adding or deleting a manifest trips only if it declares any.
    const fields = (text: string | undefined) => canonical(text === undefined ? {} : without(parseStrict(text), NON_DEPENDENCY_FIELDS), { nodes: MAX_NODES });
    if (fields(base) === fields(head)) return;
  } catch {
    f.uncompared.add("a manifest could not be parsed or is too large");
    return;
  }
  f.uncompared.add(lockChanged ? "a manifest's dependency fields changed" : "a manifest's dependency fields changed with no lockfile change");
}

type Kind = "manifest" | "lockfile" | "opaque";

/** How to treat a path, or undefined when it isn't about dependencies. Any spelling but the tool's exact one is opaque. */
function classify(path: string): Kind | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();
  if (lower === MANIFEST) return name === MANIFEST ? "manifest" : "opaque";
  if (PARSED_LOCKFILES.includes(lower)) return name === lower ? "lockfile" : "opaque";
  return OPAQUE_GLOBS.some((g) => globMatch(g, path)) ? "opaque" : undefined;
}

function summary(f: Findings): GuardrailResult {
  const counts = [
    f.added.size > 0 ? `${f.added.size} added` : "",
    f.removed.size > 0 ? `${f.removed.size} removed` : "",
    f.changed.size > 0 ? `${f.changed.size} changed` : "",
  ].filter(Boolean);
  const parts = [...(counts.length > 0 ? [`lockfile entries: ${counts.join(", ")}`] : []), ...[...f.uncompared].sort()];
  if (parts.length === 0) return { kind: "pass" };
  return { kind: "needsApproval", reason: `Dependency change. ${parts.join("; ")}.`, subjects: [...new Set([...f.added, ...f.removed, ...f.changed])].sort().slice(0, 1000) };
}

async function evaluate(diff: DiffCtx): Promise<GuardrailResult> {
  const f: Findings = { added: new Set(), removed: new Set(), changed: new Set(), uncompared: new Set() };
  const relevant = [...new Set(diff.files)].sort().flatMap((path) => {
    const kind = classify(path);
    return kind ? [{ path, kind }] : [];
  });
  const read = await Promise.all(relevant.map(async (r) => ({ ...r, base: await diff.readBase(r.path), head: await diff.readHead(r.path) })));
  const changed = read.filter((r) => r.base !== r.head || r.base === undefined);
  const lockChanged = changed.some((r) => r.kind !== "manifest");

  for (const r of changed) {
    const name = r.path.slice(r.path.lastIndexOf("/") + 1);
    if (r.base === undefined && r.head === undefined) f.uncompared.add("a changed file could not be read");
    else if (r.kind === "opaque") f.uncompared.add("a file that controls dependencies changed");
    else if (r.kind === "lockfile") compareLockfile(r.base, r.head, name, f);
    else compareManifest(r.base, r.head, lockChanged, f);
  }
  return summary(f);
}

export const dependencyChange: Guardrail = {
  id: "dependency-change",
  paths: [...DEPENDENCY_CHANGE_GLOBS],
  approvalLabel: "approved:deps",
  evaluate,
};
