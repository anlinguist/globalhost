// The `dependency-change` guardrail (ADR-0015 §8): any dependency that is new, bumped, removed or re-resolved between
// base and head, transitive lockfile entries included. Everything read is untrusted repo content. Whatever can't be
// read, parsed or compared trips; it never passes.
//
// The lockfiles it parses are compared by content, not as text, so reordered keys and whitespace don't trip and any
// other difference does: a version, an integrity hash, a tarball URL on another host, a flag.
import { globMatch, pathForms, type DiffCtx, type Guardrail, type GuardrailResult } from "@globalhost/core";
import { isScalar, parseDocument, visit } from "yaml";

/**
 * About 35 times numu-know's lockfile (233 KB). A real lockfile this size parses in about 3s. The worst hostile input
 * we found that gets past refusedBeforeParsing takes about 20s per side at this size. That is measured, not a proven
 * bound: parsing is synchronous and in-process, so a worse input could stall it or exhaust the heap, and no timeout or
 * try/catch helps. The check that posts results must run this in a child process with a heap limit and a hard kill
 * (PLAN P2-03).
 */
export const MAX_LOCKFILE_CHARS = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 2_000_000;

/**
 * Opening brackets in one file. A run of nested ones can exhaust the heap in the parser, which nothing in this process
 * survives. A lockfile-shaped file at the 8 MB cap has about 200,000; see the tests for real files.
 */
export const MAX_FLOW_OPENERS = 300_000;

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
  "**/.yarnrc",
  "**/.yarnrc.yml",
  "**/.yarn/plugins/**",
  "**/.yarn/releases/**",
  "**/.yarn/cache/**",
  "**/.pnp.*",
  "**/.npmrc",
  "**/bunfig.toml",
  "**/.pnpmfile.cjs",
  "**/.pnpmfile.mjs",
  "**/pnpm-workspace.yaml",
  "**/package.yaml",
  "**/package.json5",
  "**/binding.gyp",
  "**/patches/**",
  "**/node_modules/**",
  "**/uv.lock",
  "**/poetry.lock",
  "**/Pipfile",
  "**/Pipfile.lock",
  "**/pyproject.toml",
  "**/requirements*.txt",
  "**/requirements/**/*.txt",
];

export const DEPENDENCY_CHANGE_GLOBS: readonly string[] = Object.freeze([`**/${MANIFEST}`, ...PARSED_LOCKFILES.map((f) => `**/${f}`), ...OPAQUE_GLOBS]);

/**
 * package.json fields that say nothing about what gets installed. An allowlist, so an unfamiliar field (`overrides`,
 * `resolutions`, `pnpm`, `workspaces`, `packageManager`, `trustedDependencies`…) trips rather than passes.
 *
 * `scripts` is on it deliberately, except for INSTALL_HOOKS. An ordinary script runs repo code, as does every source
 * file and test in the same PR, and those don't trip either: this guardrail is about what comes from outside the repo.
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

/**
 * Scripts the package manager runs during an install, so they run before anything has looked at the code, and can fetch
 * from outside the repo: an image build that runs a clean install on a copied manifest runs them. Adding, changing or
 * removing one trips, in any manifest. `prepublish` and `dependencies` are on the list because npm runs them on install too.
 */
const INSTALL_HOOKS = new Set(["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare", "prepublish", "dependencies", "pnpm:devPreinstall"]);

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

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === undefined;

/**
 * Refuses in one linear pass what the parser is superlinear on, since parsing is synchronous and the engine's timeout
 * can't interrupt it: YAML's anchors, aliases and tags (none of the three lockfile formats writes them), a closing
 * bracket with nothing open, a quote straight after a closing quote, and more flow nesting or opening brackets than any
 * lockfile has. This narrows what reaches the parser; it isn't a bound. See MAX_LOCKFILE_CHARS.
 *
 * It tracks just enough to know where a value starts: inside quotes these characters are text, and inside a plain value
 * (`deprecated: use a, *not* b`) they are too. When unsure it refuses, which only costs a trip on a changed file.
 */
export function refusedBeforeParsing(text: string): boolean {
  let atStart = true; // the next non-space character begins a value or key
  let afterQuote = false; // just closed a quoted key, where `"a":&x` needs no space after the colon
  let flowDepth = 0;
  let openers = 0;
  // A document marker can carry properties, so step over it. A byte order mark counts as nothing either.
  const skipMarker = (from: number) => (text.startsWith("---", from) && isSpace(text[from + 3]) ? from + 3 : from);
  const first = text.startsWith("\uFEFF") ? 1 : 0;
  for (let i = skipMarker(first); i < text.length; i++) {
    const c = text[i]!;
    if (c === "\n" || c === "\r") {
      atStart = true;
      afterQuote = false;
      i = skipMarker(i + 1) - 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\uFEFF") continue;
    if (c === "#" && (atStart || isSpace(text[i - 1]))) {
      const end = text.indexOf("\n", i);
      if (end === -1) return false;
      i = end - 1;
      continue;
    }
    if (c === "[" || c === "{") {
      if (atStart || flowDepth > 0) {
        if (++flowDepth > MAX_DEPTH || ++openers > MAX_FLOW_OPENERS) return true;
        atStart = true;
      }
      continue;
    }
    if (c === "]" || c === "}") {
      if (flowDepth === 0) return true; // nothing is open. A real plain value with one only costs a trip on a changed file.
      flowDepth--;
      atStart = false;
      continue;
    }
    if (c === "," && flowDepth > 0) {
      atStart = true;
      afterQuote = false;
      continue;
    }
    if (!atStart) {
      if (afterQuote && (c === '"' || c === "'")) return true; // a quote straight after a closing quote is never valid
      if (c === ":" && (afterQuote || isSpace(text[i + 1]))) atStart = true;
      afterQuote = false;
      continue;
    }
    if (c === "&" || c === "*" || c === "!") return true;
    if ((c === "-" || c === "?" || c === ":") && isSpace(text[i + 1])) continue;
    if (c === '"' || c === "'") {
      for (i++; i < text.length; i++) {
        if (c === '"' && text[i] === "\\") i++;
        else if (text[i] === c) {
          if (c === "'" && text[i + 1] === "'") i++;
          else break;
        }
      }
      afterQuote = true;
    }
    atStart = false;
  }
  return false;
}

/**
 * Parses npm's JSON, bun's JSON-with-trailing-commas and pnpm's YAML with one strict parser, since YAML is a superset of
 * the other two. Refuses several documents (reported only above logLevel "silent"), anchors, aliases and tags (see
 * above) and duplicate keys (parsers disagree on which one wins). The failsafe schema keeps scalars as written, so `1.0`
 * and `1.00` stay different. Duplicates are checked here because the library's `uniqueKeys` is quadratic in a map's size,
 * and `prettyErrors` is off because it is quadratic in the number of errors.
 */
function parseStrict(text: string): Record<string, unknown> {
  if (text.length > MAX_LOCKFILE_CHARS || refusedBeforeParsing(text)) throw new Unreadable();
  const doc = parseDocument(text, { schema: "failsafe", uniqueKeys: false, logLevel: "error", prettyErrors: false });
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
    if (isMap(doc.packages) && isMap(doc.packages[""])) doc.packages = { ...doc.packages, "": without(doc.packages[""], NON_DEPENDENCY_FIELDS) };
  } else if (file === "bun.lock" && isMap(doc.workspaces) && isMap(doc.workspaces[""])) {
    doc = { ...doc, workspaces: { ...doc.workspaces, "": without(doc.workspaces[""], NON_DEPENDENCY_FIELDS) } };
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

/** A manifest's dependency fields and install hooks, each as stable text. A missing side has neither. */
function manifestParts(text: string | undefined): { fields: string; hooks: string } {
  const doc = text === undefined ? {} : parseStrict(text);
  const scripts = doc.scripts;
  // A `scripts` that isn't a map isn't anything a tool runs, but it's not ours to say so: it compares whole.
  const hooks = isMap(scripts) ? Object.fromEntries(Object.entries(scripts).filter(([k]) => INSTALL_HOOKS.has(k))) : (scripts ?? {});
  return { fields: canonical(without(doc, NON_DEPENDENCY_FIELDS), { nodes: MAX_NODES }), hooks: canonical(hooks, { nodes: MAX_NODES }) };
}

function compareManifest(base: string | undefined, head: string | undefined, lockChanged: boolean, f: Findings): void {
  let before: ReturnType<typeof manifestParts>;
  let after: ReturnType<typeof manifestParts>;
  try {
    before = manifestParts(base);
    after = manifestParts(head);
  } catch {
    f.uncompared.add("a manifest could not be parsed or is too large");
    return;
  }
  if (before.hooks !== after.hooks) f.uncompared.add("a manifest's install hooks changed");
  if (before.fields !== after.fields) f.uncompared.add(lockChanged ? "a manifest's dependency fields changed" : "a manifest's dependency fields changed with no lockfile change");
}

type Kind = "manifest" | "lockfile" | "opaque";

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * How to treat a path, or undefined when it isn't about dependencies. It looks at the spellings the engine routes on
 * (pathForms), so anything the engine sends here gets a kind. Opaque globs go first: a manifest under `node_modules/` is
 * vendored code. Only the tool's exact file name gets parsed; any other spelling of it is opaque.
 */
function classify(path: string): Kind | undefined {
  const forms = pathForms(path);
  if (forms.some((form) => OPAQUE_GLOBS.some((g) => globMatch(g, form)))) return "opaque";
  const name = basename(path);
  if (name === MANIFEST) return "manifest";
  if (PARSED_LOCKFILES.includes(name)) return "lockfile";
  return forms.some((form) => [MANIFEST, ...PARSED_LOCKFILES].includes(basename(form).toLowerCase())) ? "opaque" : undefined;
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
    const name = basename(r.path);
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
