// Guardrails engine (ADR-0015 §8, PLAN P2-03). Given what a PR changed, returns every escalation trigger and guardrail
// with a verdict, deterministically and with no I/O beyond the DiffCtx the caller passes.
//
// Relation to the path policy (path-policy.ts): the publisher's refusal stays where it is and still refuses agent
// bundles before they are pushed. This engine runs later, on the PR, for any author, and reuses the same matcher. It
// feeds that matcher extra spellings of each path (pathForms), so case, `./`, `..`, `\`, trailing dots and lookalike
// characters can only add a match, never lose one.
//
// Results may be posted: nothing in them is the raw path, exception text or guardrail text. See safePath and safeText.
import { maskSecrets } from "@globalhost/sanitize";
import { z } from "zod";
import { IMMUTABLE_BASELINE, GLOB_PATTERN } from "./factory-yaml/schema.js";
import type { FactoryConfig } from "./factory-yaml/validate.js";
import {
  APPROVAL_LABEL_PATTERN,
  CLEARABLE_CLASSES,
  evaluateApproval,
  type ApprovalDecision,
  type ApprovalEvidence,
  type GuardrailClass,
} from "./guardrail-approval.js";
import { globMatch, isRepoRelativePath, isReservedRecordPath } from "./path-policy.js";
import type { DiffCtx, Guardrail, Profile, ReleaseExecutionSet } from "./profile.js";
import { normalizeForScan } from "./review-scan.js";

/** ADR-0015 §8: files that instruct agents. No factory.yaml setting removes these. */
export const INSTRUCTION_SURFACE_GLOBS: readonly string[] = Object.freeze([
  "**/CLAUDE.md",
  "**/CLAUDE.local.md",
  "**/AGENTS.md",
  "**/.claude/**",
  ".mcp.json",
  "docs/product/**",
  "skills/**",
]);

/**
 * ADR-0015 §8: paths that run with prod credentials, apart from the adapter's release execution set. Root only, like
 * the immutable baseline: a `factory.yaml` or `.github/` in a subdirectory is read by nothing (the factory and GitHub
 * only look at the root), so it is an ordinary file.
 */
export const PROD_CREDENTIAL_GLOBS: readonly string[] = Object.freeze(["factory.yaml", ".github/**"]);

/** The label that acknowledges a `loadBearing` hit. */
export const LOAD_BEARING_LABEL = "approved:load-bearing";

export const MAX_RESULT_PATHS = 50;
export const MAX_RESULT_SUBJECTS = 20;
const MAX_SAFE_PATH = 300;
const MAX_SAFE_TEXT = 300;
/** Long enough for a large lockfile on a slow runner; a guardrail that hangs must not hang the check. */
export const GUARDRAIL_TIMEOUT_MS = 60_000;

// Git modes of an ordinary file, or of nothing on that side. Any other (symlink 120000, submodule 160000) trips.
const PLAIN_MODES = new Set(["000000", "100644", "100755"]);

export interface ChangedFile {
  /** The path at head, as git reports it. Attacker-chosen: only ever matched, or rendered through safePath. */
  path: string;
  /** For a rename or copy, the old path. It counts as changed just like the new one. */
  previousPath?: string;
  /** Git modes on either side, when the caller can see them (`git diff --raw`). */
  modes?: readonly string[];
}

/** One deploy target's declared set. `set` undefined means the adapter declared none, which trips. */
export interface ReleaseSetDeclaration {
  part: string;
  adapter: string;
  set: ReleaseExecutionSet | undefined;
}

export interface GuardrailInputs {
  /** Globs from factory.yaml on the base branch. The baseline is added here too, so a caller can't leave it out. */
  config: { loadBearing: readonly string[]; immutable: readonly string[] };
  guardrails: readonly Guardrail[];
  releaseSets: readonly ReleaseSetDeclaration[];
  /** Parts whose profile isn't registered: their checks can't run, so this trips. */
  unknownProfiles: readonly string[];
}

export interface GuardrailEngineInput extends GuardrailInputs {
  files: readonly ChangedFile[];
  /** False when the caller's file list may be cut short (an API page limit). */
  filesComplete: boolean;
  /** How guardrails read file contents. Its `files` is rebuilt from `files`. */
  diff: Pick<DiffCtx, "readBase" | "readHead">;
  approval: ApprovalEvidence;
  timeoutMs?: number;
}

export type EntryVerdict = "pass" | "needsApproval" | "fail";

export interface GuardrailEntry {
  /** A fixed trigger ID or a validated guardrail ID. */
  id: string;
  class: GuardrailClass;
  verdict: EntryVerdict;
  /** Fixed text, or a guardrail's reason passed through safeText. */
  reason: string;
  /** What tripped it, through safePath, sorted. Show in a code span; for a prompt, still fence it as untrusted. */
  paths: string[];
  pathsOmitted: number;
  /** What it is about (say, packages), through safePath, sorted. Same rendering rule as `paths`. */
  subjects: string[];
  subjectsOmitted: number;
  /** The label that clears this entry, or null when none can. */
  approvalLabel: string | null;
  /** Set only for an entry that needed approval and could get it. */
  approval: ApprovalDecision | null;
}

export interface GuardrailReport {
  /** `pass` when nothing is left to acknowledge, `needsApproval` when something is, `fail` when anything failed. */
  verdict: EntryVerdict;
  entries: GuardrailEntry[];
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const unique = (items: Iterable<string>) => [...new Set(items)].sort(byCodeUnit);

function percentEncode(text: string): string {
  // Bytes rather than encodeURIComponent, which throws on a lone surrogate.
  let out = "";
  for (const byte of new TextEncoder().encode(text)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9._/+-]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * A path or other attacker-chosen name, safe to post: secret-shaped text masked, then everything outside
 * `[A-Za-z0-9._/+-]` percent-encoded, so no newline, markup, ping, bidi or invisible character survives and a
 * lookalike shows up as bytes instead of looking like the real name. It still spells words, so keep it in a code
 * span, and fence it as untrusted before it goes near a prompt.
 */
export function safePath(path: string): string {
  const out = percentEncode(maskSecrets(path).text);
  return out.length > MAX_SAFE_PATH ? `${out.slice(0, MAX_SAFE_PATH).replace(/%[0-9A-F]?$/, "")}...` : out;
}

/** A guardrail's reason. Written by profile code, which may have quoted a repo; only plain prose characters survive. */
export function safeText(text: string): string {
  const out = maskSecrets(text)
    .text.replace(/[^A-Za-z0-9 .,:;()/_=+'-]/g, "?")
    .replace(/:\/\//g, ":?/")
    .slice(0, MAX_SAFE_TEXT)
    .trim();
  return out === "" ? "no reason given" : out;
}

/** Resolve `.`, `..`, `\` and `//` the way a filesystem would. Undefined when it climbs out of the repo. */
function lexicalPath(path: string): string | undefined {
  const out: string[] = [];
  for (const seg of path.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.pop() === undefined) return undefined;
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/**
 * Every spelling of a path to match: as given, resolved, and folded (compatibility forms, lookalikes, invisibles and
 * accents via the review scan's normalizer, full case folding, and the trailing dots and spaces Windows drops).
 */
export function pathForms(path: string): string[] {
  const lexical = lexicalPath(path) ?? path;
  const folded = lexical === "" ? "" : normalizeForScan(lexical).toUpperCase().toLowerCase();
  const trimmed = (lexicalPath(folded) ?? folded)
    .split("/")
    .map((s) => s.replace(/[. ]+$/, ""))
    .join("/");
  return unique([path, lexical, trimmed].filter((p) => p !== ""));
}

const matchesAny = (globs: readonly string[], path: string) => pathForms(path).some((form) => globs.some((g) => globMatch(g, form)));

const validGlobs = (globs: unknown): globs is string[] =>
  Array.isArray(globs) && globs.length > 0 && globs.every((g) => typeof g === "string" && GLOB_PATTERN.test(g));

/** Adapter declaration → usable set; a throw or a malformed answer is the same as declaring none. */
function declaredSet(declare: () => ReleaseExecutionSet | undefined): ReleaseExecutionSet | undefined {
  try {
    const set = declare();
    return set && validGlobs(set.globs) ? set : undefined;
  } catch {
    return undefined;
  }
}

/** Part-relative glob → repo-relative. */
const inPart = (partPath: string, glob: string) => (partPath === "." ? glob : `${partPath}/${glob}`);

/** The parts of a Registry the engine reads, so a registry of any concrete profile and adapter types fits. */
export interface GuardrailRegistry {
  profile(id: string): Pick<Profile, "guardrails"> | undefined;
  adapter(id: string): { releaseExecutionSet?(part: { name: string; path: string }, cfg: never): ReleaseExecutionSet } | undefined;
}

/**
 * The engine's inputs from a validated factory.yaml and the registered profiles and adapters. Pass the config from
 * the base branch: the PR's own copy could drop a glob or an owner. A part with a `release` entry is a prod part.
 */
export function guardrailInputsFor(
  config: Pick<FactoryConfig, "parts" | "guardrails">,
  registry: GuardrailRegistry,
): GuardrailInputs {
  const immutable = [...config.guardrails.immutable];
  const guardrails: Guardrail[] = [];
  const releaseSets: ReleaseSetDeclaration[] = [];
  const unknownProfiles: string[] = [];
  for (const [part, cfg] of Object.entries(config.parts)) {
    const profile = registry.profile(cfg.profile);
    if (profile) {
      immutable.push(...profile.guardrails.immutable.map((g) => inPart(cfg.path, g)));
      guardrails.push(...profile.guardrails.checks);
    } else {
      unknownProfiles.push(part);
    }
    for (const release of cfg.release) {
      const adapter = registry.adapter(release.adapter);
      const set = declaredSet(() => adapter?.releaseExecutionSet?.({ name: part, path: cfg.path }, release.config as never));
      releaseSets.push({ part, adapter: release.adapter, set });
    }
  }
  return { config: { loadBearing: config.guardrails.loadBearing, immutable }, guardrails, releaseSets, unknownProfiles };
}

const GUARDRAIL_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SUBJECT_LIMIT = 1000;
const GuardrailResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pass") }),
  z.strictObject({
    kind: z.enum(["needsApproval", "fail"]),
    reason: z.string().min(1),
    subjects: z.array(z.string()).max(SUBJECT_LIMIT).optional(),
  }),
]);

const TRIGGER_IDS = [
  "file-list",
  "malformed-path",
  "redirecting-file",
  "guardrail-config",
  "instruction-surface",
  "prod-credential",
  "release-set",
  "release-set-undeclared",
  "immutable",
  "load-bearing",
] as const;

function capped(raw: Iterable<string>, max: number): { items: string[]; omitted: number } {
  const all = unique(raw);
  return { items: unique(all.slice(0, max).map(safePath)), omitted: Math.max(0, all.length - max) };
}

function entry(
  id: string,
  cls: GuardrailClass,
  verdict: EntryVerdict,
  reason: string,
  evidence: { paths?: Iterable<string>; subjects?: Iterable<string> | undefined; label?: string | null } = {},
): GuardrailEntry {
  const paths = capped(evidence.paths ?? [], MAX_RESULT_PATHS);
  const subjects = capped(evidence.subjects ?? [], MAX_RESULT_SUBJECTS);
  return {
    id,
    class: cls,
    verdict,
    reason,
    paths: paths.items,
    pathsOmitted: paths.omitted,
    subjects: subjects.items,
    subjectsOmitted: subjects.omitted,
    approvalLabel: evidence.label ?? null,
    approval: null,
  };
}

/** A trigger: trips when `paths` is non-empty. Unless a label is given, only the owner's ship gets past it. */
function pathTrigger(id: (typeof TRIGGER_IDS)[number], cls: GuardrailClass, paths: string[], tripped: string, clean: string, label: string | null = null): GuardrailEntry {
  return paths.length === 0 ? entry(id, cls, "pass", clean, { label }) : entry(id, cls, "needsApproval", tripped, { paths, label });
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("guardrail timed out")), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs one guardrail. A throw, a timeout or a bad return is `fail`: fixed text only, since an error can quote anything. */
async function runGuardrail(g: Guardrail, paths: readonly string[], input: GuardrailEngineInput): Promise<GuardrailEntry> {
  const tripping = paths.filter((p) => matchesAny(g.paths, p));
  if (tripping.length === 0) return entry(g.id, "guardrail", "pass", "no matching paths changed", { label: g.approvalLabel });
  let result: z.output<typeof GuardrailResultSchema>;
  try {
    // A fresh copy for each: one guardrail mustn't be able to change what the next one sees.
    const diff: DiffCtx = { files: [...paths], readBase: (p) => input.diff.readBase(p), readHead: (p) => input.diff.readHead(p) };
    const raw: unknown = await withTimeout(Promise.resolve().then(() => g.evaluate(diff)), input.timeoutMs ?? GUARDRAIL_TIMEOUT_MS);
    const parsed = GuardrailResultSchema.safeParse(raw);
    if (!parsed.success) return entry(g.id, "guardrail", "fail", "guardrail returned an invalid result", { paths: tripping });
    result = parsed.data;
  } catch {
    return entry(g.id, "guardrail", "fail", "guardrail failed to run", { paths: tripping });
  }
  if (result.kind === "pass") return entry(g.id, "guardrail", "pass", "no change that needs approval", { label: g.approvalLabel });
  return entry(g.id, "guardrail", result.kind, safeText(result.reason), {
    paths: tripping,
    subjects: result.subjects,
    label: result.kind === "needsApproval" ? g.approvalLabel : null,
  });
}

const usableId = (id: unknown): id is string => typeof id === "string" && GUARDRAIL_ID.test(id) && !(TRIGGER_IDS as readonly string[]).includes(id);

/** Why a guardrail's definition can't be trusted, or null. A glob that can't match would silently never run. */
function definitionProblem(g: Guardrail, labels: Map<string, Set<string>>, ids: Map<string, Set<Guardrail>>): string | null {
  if (!usableId(g.id)) return "guardrail has an invalid or reserved ID";
  if (typeof g.approvalLabel !== "string" || !APPROVAL_LABEL_PATTERN.test(g.approvalLabel) || g.approvalLabel === LOAD_BEARING_LABEL) {
    return "guardrail has an invalid or reserved approval label";
  }
  if (!validGlobs(g.paths) || typeof g.evaluate !== "function") return "guardrail has invalid paths or no evaluate function";
  if ((ids.get(g.id)?.size ?? 0) > 1) return "another guardrail has the same ID";
  // A label clears only its own guardrail, so two guardrails can't share one.
  if ((labels.get(g.approvalLabel)?.size ?? 0) > 1) return "another guardrail has the same approval label";
  return null;
}

async function guardrailEntries(input: GuardrailEngineInput, paths: readonly string[]): Promise<GuardrailEntry[]> {
  // The same profile on two parts hands in the same object twice; that's one guardrail.
  const distinct = [...new Set(input.guardrails)];
  const ids = new Map<string, Set<Guardrail>>();
  const labels = new Map<string, Set<string>>();
  for (const g of distinct) {
    try {
      const { id, approvalLabel: label } = g;
      ids.set(id, (ids.get(id) ?? new Set()).add(g));
      labels.set(label, (labels.get(label) ?? new Set()).add(id));
    } catch {
      // definitionProblem hits the same throwing getter below.
    }
  }

  const out: GuardrailEntry[] = [];
  for (const [i, g] of distinct.entries()) {
    let problem: string | null;
    let safeId = `invalid-guardrail-${i}`;
    try {
      problem = definitionProblem(g, labels, ids);
      if (usableId(g.id)) safeId = g.id;
    } catch {
      problem = "guardrail definition could not be read";
    }
    out.push(problem ? entry(safeId, "guardrail", "fail", problem) : await runGuardrail(g, paths, input));
  }
  return out.sort((a, b) => byCodeUnit(a.id, b.id) || byCodeUnit(a.reason, b.reason));
}

function triggerEntries(input: GuardrailEngineInput, paths: readonly string[], malformed: readonly string[]): GuardrailEntry[] {
  const hits = (globs: readonly string[]) => paths.filter((p) => matchesAny(globs, p));
  const immutableGlobs = [...IMMUTABLE_BASELINE, ...input.config.immutable];
  const releaseGlobs = input.releaseSets.flatMap((r) => r.set?.globs ?? []);
  const undeclared = input.releaseSets.filter((r) => r.set === undefined);
  const redirecting = input.files.filter((f) => f.modes?.some((m) => !PLAIN_MODES.has(m)));
  const fileListBad = !input.filesComplete || input.files.length === 0;

  return [
    fileListBad
      ? entry("file-list", "integrity", "fail", "the list of changed files is empty or incomplete")
      : entry("file-list", "integrity", "pass", "the list of changed files is complete"),
    malformed.length > 0
      ? entry("malformed-path", "integrity", "fail", "a changed path is not a plain repo-relative path, which git never reports", { paths: malformed })
      : entry("malformed-path", "integrity", "pass", "every changed path is a plain repo path"),
    pathTrigger(
      "redirecting-file",
      "integrity",
      redirecting.flatMap((f) => [f.path, ...(f.previousPath === undefined ? [] : [f.previousPath])]),
      "a changed file is a symlink, submodule or unknown file type, so its path doesn't say what it points at",
      "no symlink, submodule or unknown file type changed",
    ),
    input.unknownProfiles.length > 0
      ? entry("guardrail-config", "integrity", "fail", "a part's profile is not registered, so its guardrails can't run", { subjects: input.unknownProfiles })
      : entry("guardrail-config", "integrity", "pass", "every part's profile is registered"),
    pathTrigger("instruction-surface", "instruction-surface", hits(INSTRUCTION_SURFACE_GLOBS), "a changed file instructs agents", "no instruction file changed"),
    pathTrigger("prod-credential", "prod-credential", hits(PROD_CREDENTIAL_GLOBS), "a changed file runs with prod credentials", "no prod-credential path changed"),
    pathTrigger("release-set", "release-set", hits(releaseGlobs), "a changed file is in the release execution set", "no release execution file changed"),
    undeclared.length > 0
      ? entry("release-set-undeclared", "release-set", "needsApproval", "a prod part's deploy adapter declares no release execution set", {
          subjects: undeclared.map((r) => `${r.part}/${r.adapter}`),
        })
      : entry("release-set-undeclared", "release-set", "pass", "every prod part's deploy adapter declares its release execution set"),
    pathTrigger(
      "immutable",
      "immutable",
      paths.filter((p) => matchesAny(immutableGlobs, p) || pathForms(p).some(isReservedRecordPath)),
      "a changed file is one agents may never change",
      "no immutable path changed",
    ),
    pathTrigger("load-bearing", "load-bearing", hits(input.config.loadBearing), "a changed file is listed in loadBearing", "no load-bearing path changed", LOAD_BEARING_LABEL),
  ];
}

/** Applies each entry's own label, if it can have one. */
function withApproval(e: GuardrailEntry, evidence: ApprovalEvidence): GuardrailEntry {
  if (e.verdict !== "needsApproval" || e.approvalLabel === null || !CLEARABLE_CLASSES.includes(e.class)) return e;
  return { ...e, approval: evaluateApproval({ class: e.class, approvalLabel: e.approvalLabel }, evidence) };
}

function reportVerdict(entries: readonly GuardrailEntry[]): EntryVerdict {
  if (entries.some((e) => e.verdict === "fail")) return "fail";
  return entries.some((e) => e.verdict === "needsApproval" && !e.approval?.cleared) ? "needsApproval" : "pass";
}

export async function evaluateGuardrails(input: GuardrailEngineInput): Promise<GuardrailReport> {
  const named = unique(input.files.flatMap((f) => (f.previousPath === undefined ? [f.path] : [f.path, f.previousPath])));
  const malformed = named.filter((p) => !isRepoRelativePath(p));
  // A malformed path still counts against the protected lists (via its resolved form), and fails on its own.
  const triggers = triggerEntries(input, named, malformed);
  // Guardrails read files, so they only see paths a reader can be trusted with.
  const guardrails = await guardrailEntries(input, named.filter(isRepoRelativePath));
  const entries = [...triggers, ...guardrails].map((e) => withApproval(e, input.approval));
  return { verdict: reportVerdict(entries), entries };
}
