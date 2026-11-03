// Toolchain requirements (P2-01): which tool versions a product repo's base commit asks for, and whether an agent
// used them. Core knows only the generic shape: a tool id, a version range in one canonical grammar, the file it
// came from, and the commands to check and get it. Reading a repo's version files (and their ecosystem's range
// syntax) is a profile's job (CLAUDE.md #1); profiles convert into the canonical grammar below.
//
// Canonical range grammar (how ranges are stored and shown to agents):
//   range      := set ( " || " set )*
//   set        := comparator ( " " comparator )*
//   comparator := op? version        op ∈ { >=, >, <=, <, = } (none means "=")
//   version    := N ( "." N ( "." N )? )?   N = 1–6 digits, no leading zeros
// A partial version is a prefix: "=22" (or "22") is any 22.x.y, ">22" is 23 and above, "<=22" is anything up to
// the last 22.x.y. Nothing else (pre-release tags, wildcards, named aliases) is accepted, and every alternative must
// admit at least one version (">=21 <20" is rejected).
import { z } from "zod";

/** A tool id (a runtime or package manager name). Chosen by profiles; core treats it as an opaque name. */
export const TOOL_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_TOOLS = 8;
export const MAX_RANGE_CHARS = 100;
export const MAX_TOOLCHAIN_NOTES = 20;
const MAX_TOOL_TEXT = 300;
const MAX_VERSION_PART = 999_999;

export const RANGE_OPS = [">=", ">", "<=", "<", "="] as const;
export type RangeOp = (typeof RANGE_OPS)[number];
export interface Comparator {
  op: RangeOp;
  /** 1–3 numeric parts. */
  version: number[];
}
/** OR of ANDs. */
export type VersionRange = Comparator[][];

const NUM = "(?:0|[1-9]\\d{0,5})";
const VERSION_RE = new RegExp(`^${NUM}(?:\\.${NUM}){0,2}$`);
const COMPARATOR_RE = new RegExp(`^(>=|>|<=|<|=)?(${NUM}(?:\\.${NUM}){0,2})$`);
/** What an agent may report as the version it used: digits and dots, an optional leading "v". */
export const REPORTED_VERSION = new RegExp(`^v?${NUM}(?:\\.${NUM}){0,2}$`);

function parseNumbers(text: string): number[] | undefined {
  if (!VERSION_RE.test(text)) return undefined;
  const parts = text.split(".").map(Number);
  return parts.every((n) => Number.isSafeInteger(n) && n <= MAX_VERSION_PART) ? parts : undefined;
}

/** Parses a range in the canonical grammar exactly (single spaces, " || " between sets); anything else is undefined. */
export function parseVersionRange(text: string): VersionRange | undefined {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_RANGE_CHARS) return undefined;
  const range: VersionRange = [];
  for (const setText of text.split(" || ")) {
    const set: Comparator[] = [];
    for (const c of setText.split(" ")) {
      const m = COMPARATOR_RE.exec(c);
      const version = m?.[2] === undefined ? undefined : parseNumbers(m[2]);
      if (!m || !version) return undefined;
      set.push({ op: (m[1] ?? "=") as RangeOp, version });
    }
    if (set.length === 0 || set.length > 4) return undefined;
    range.push(set);
  }
  return range.length > 0 && range.length <= 8 && versionRangeSatisfiable(range) ? range : undefined;
}

const pad3 = (v: readonly number[]): number[] => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
/** The first version after every version with prefix `v`: 22 → 23.0.0, 22.1 → 22.2.0. */
const afterPrefix = (v: readonly number[]): number[] => pad3([...v.slice(0, -1), (v.at(-1) ?? 0) + 1]);
const cmp3 = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return Math.sign((a[i] ?? 0) - (b[i] ?? 0));
  return 0;
};

/**
 * True when every `||` alternative admits at least one version. Each comparator is a half-open interval
 * [lo, hi) of full versions; a set is satisfiable when the intersection of its intervals is non-empty.
 */
export function versionRangeSatisfiable(range: VersionRange): boolean {
  return range.every((set) => {
    let lo = [0, 0, 0];
    let hi: number[] | undefined; // undefined = unbounded
    const raise = (v: number[]) => (lo = cmp3(v, lo) > 0 ? v : lo);
    const lower = (v: number[]) => (hi = hi === undefined || cmp3(v, hi) < 0 ? v : hi);
    for (const c of set) {
      if (c.op === "=") {
        raise(pad3(c.version));
        lower(afterPrefix(c.version));
      } else if (c.op === ">=") raise(pad3(c.version));
      else if (c.op === ">") raise(afterPrefix(c.version));
      else if (c.op === "<") lower(pad3(c.version));
      else lower(afterPrefix(c.version));
    }
    return hi === undefined || cmp3(lo, hi) < 0;
  });
}

/** The canonical text of a range; "=" is written bare. Throws on a range that wouldn't parse back. */
export function formatVersionRange(range: VersionRange): string {
  const text = range.map((set) => set.map((c) => `${c.op === "=" ? "" : c.op}${c.version.join(".")}`).join(" ")).join(" || ");
  if (!parseVersionRange(text)) throw new Error("not a valid version range");
  return text;
}

/** A reported tool version ("v22.11.0", "3.12.3", "1.2") as numbers, or undefined. */
export function parseToolVersion(text: string): number[] | undefined {
  if (typeof text !== "string" || !REPORTED_VERSION.test(text)) return undefined;
  return parseNumbers(text.replace(/^v/, ""));
}

/** Compares `version` with the first `prefix.length` parts of itself (missing parts count as 0). */
function comparePrefix(version: readonly number[], prefix: readonly number[]): number {
  for (let i = 0; i < prefix.length; i++) {
    const d = (version[i] ?? 0) - (prefix[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export function versionSatisfies(version: readonly number[], range: VersionRange): boolean {
  return range.some((set) =>
    set.every((c) => {
      const d = comparePrefix(version, c.version);
      switch (c.op) {
        case "=":
          return d === 0;
        case ">=":
          return d >= 0;
        case ">":
          return d > 0;
        case "<":
          return d < 0;
        case "<=":
          return d <= 0;
      }
    }),
  );
}

// Trusted, profile-written text that goes into the task message: one line, no control characters.
const toolText = z
  .string()
  .min(1)
  .max(MAX_TOOL_TEXT)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u, "one line of printable text");
/**
 * Repo-relative path of the file a requirement came from: the characters factory.yaml allows in part paths
 * (repoPath) plus "/", no "." or ".." segments. Long enough for a maximal part path plus a file name.
 */
const SOURCE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+/-]{1,400}$/;

export const ToolRequirementSchema = z.strictObject({
  tool: z.string().regex(TOOL_ID),
  /** Canonical range (grammar above). */
  range: z.string().refine((r) => parseVersionRange(r) !== undefined, "not a canonical version range"),
  /** Repo-relative file the range was read from, on the base commit. */
  source: z.string().regex(SOURCE_PATH),
  /** A command that prints the version in use, e.g. "<tool> --version". */
  check: toolText,
  /** How to get a satisfying version in the agent sandbox. */
  install: toolText,
});
export type ToolRequirement = z.infer<typeof ToolRequirementSchema>;

export const ToolchainSchema = z.strictObject({
  tools: z
    .array(ToolRequirementSchema)
    .max(MAX_TOOLS)
    .refine((ts) => new Set(ts.map((t) => t.tool)).size === ts.length, "a tool appears twice"),
  /** Fixed-text notes from detection (ignored values, disagreeing sources). Never repo text. */
  notes: z.array(toolText).max(MAX_TOOLCHAIN_NOTES),
});
export type Toolchain = z.infer<typeof ToolchainSchema>;

export const EMPTY_TOOLCHAIN: Toolchain = { tools: [], notes: [] };

/**
 * The versions an agent says it used (report.json `toolchain`): tool id → version. Agent-written, so untrusted:
 * keys and values must match strict patterns, and there are at most MAX_TOOLS entries.
 */
export const ReportedToolchainSchema = z
  .record(z.string().regex(TOOL_ID), z.string().regex(REPORTED_VERSION))
  .refine((r) => Object.keys(r).length <= MAX_TOOLS, `at most ${MAX_TOOLS} tools`);
export type ReportedToolchain = z.infer<typeof ReportedToolchainSchema>;

/**
 * Merges each part's toolchain in part order. A tool required by several parts keeps the first part's range when
 * they disagree, with a note: one sandbox runs one version of a tool.
 */
export function mergeToolchains(parts: readonly { part: string; toolchain: Toolchain }[]): Toolchain {
  const tools = new Map<string, ToolRequirement>();
  const notes: string[] = [];
  for (const { toolchain } of parts) {
    notes.push(...toolchain.notes);
    for (const t of toolchain.tools) {
      const prev = tools.get(t.tool);
      if (!prev) tools.set(t.tool, t);
      else if (prev.range !== t.range) {
        notes.push(`${t.tool}: ${prev.source} asks for ${prev.range} and ${t.source} for ${t.range}; using ${prev.range}`);
      }
    }
  }
  return ToolchainSchema.parse({
    tools: [...tools.values()].slice(0, MAX_TOOLS),
    notes: [...new Set(notes)].map((n) => n.slice(0, MAX_TOOL_TEXT)).slice(0, MAX_TOOLCHAIN_NOTES),
  });
}

export const TOOL_CHECK_STATUSES = ["match", "mismatch", "unreported"] as const;
export type ToolCheckStatus = (typeof TOOL_CHECK_STATUSES)[number];

export const ToolCheckSchema = z.strictObject({
  tool: z.string().regex(TOOL_ID),
  required: z.string(),
  source: z.string(),
  /** What the agent reported, normalized (no "v"); null when it reported nothing valid for this tool. */
  reported: z.string().nullable(),
  status: z.enum(TOOL_CHECK_STATUSES),
});
export type ToolCheck = z.infer<typeof ToolCheckSchema>;

/** run.json's `toolchain`: what the base commit required and how the agent's report compares. Harness-written. */
export const ToolchainRecordSchema = z.strictObject({
  required: ToolchainSchema,
  checks: z.array(ToolCheckSchema).max(MAX_TOOLS),
  /** The agent's `toolchain` was present but didn't match ReportedToolchainSchema, so it was ignored. */
  reportInvalid: z.boolean(),
});
export type ToolchainRecord = z.infer<typeof ToolchainRecordSchema>;

/**
 * Compares the agent's reported versions (raw, untrusted: report.json's `toolchain` value) with the requirement.
 * Only required tools are checked; extra reported tools are ignored.
 */
export function checkToolchain(required: Toolchain, reportedRaw: unknown): ToolchainRecord {
  const parsed = reportedRaw === undefined ? undefined : ReportedToolchainSchema.safeParse(reportedRaw);
  // Each required tool is read on its own, so one stray key doesn't void the rest; the shape problem is still flagged.
  const obj = typeof reportedRaw === "object" && reportedRaw !== null && !Array.isArray(reportedRaw) ? (reportedRaw as Record<string, unknown>) : {};
  const checks = required.tools.map((t): ToolCheck => {
    const raw = Object.hasOwn(obj, t.tool) ? obj[t.tool] : undefined;
    const version = typeof raw === "string" ? parseToolVersion(raw) : undefined;
    const range = parseVersionRange(t.range);
    const base = { tool: t.tool, required: t.range, source: t.source };
    if (!version || !range) return { ...base, reported: null, status: "unreported" };
    return { ...base, reported: version.join("."), status: versionSatisfies(version, range) ? "match" : "mismatch" };
  });
  return { required, checks, reportInvalid: parsed !== undefined && !parsed.success };
}

/** Fixed-text problem lines for run.json: one per tool that didn't match, plus an ignored report. */
export function toolchainProblems(record: ToolchainRecord): string[] {
  const out: string[] = [];
  for (const c of record.checks) {
    if (c.status === "mismatch") out.push(`toolchain: ${c.tool} ${c.reported} used, but ${c.source} on the base commit requires ${c.required}`);
    if (c.status === "unreported") out.push(`toolchain: the agent didn't report which ${c.tool} it used (required ${c.required} by ${c.source})`);
  }
  if (record.reportInvalid) out.push("toolchain: report.json's toolchain didn't match the expected shape and was ignored");
  return out;
}
