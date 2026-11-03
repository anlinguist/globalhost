// What the review harness reads besides the PR (P2-01): a bounded summary of the CI run, the CI run's
// screenshots, and the PR diff for the deterministic scan. All of it is PR-controlled (CI runs PR code), so it
// is capped and truncated here, before scanning and before the reviewer sees it, and passed on only as data.
import { spawn } from "node:child_process";
import { realpath, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddedLine } from "@globalhost/core";
import { maskSecrets, stripControlChars } from "@globalhost/sanitize";
import { z } from "zod";
import type { GitHubClient } from "./github.js";
import { readZip, type ZipLimits } from "./zip.js";

// ---- CI summary ----

/** The whole summary, sized to fit the review prompt's CI section (runner MAX_REVIEW_CI_CHARS is 20 000). */
export const MAX_CI_SUMMARY_CHARS = 18_000;
/** The job and step list, before any log text. */
const MAX_JOB_LIST_CHARS = 5_000;
/** Log tail per job: read at most this much of each log, keeping the end. */
const MAX_LOG_BYTES = 64 * 1024;
/** Each job's tail gets an equal share of what the job list leaves, but at least this. */
const MIN_TAIL_CHARS = 400;
const MAX_JOBS = 20;
const MAX_NAME = 100;

const JobsSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      conclusion: z.string().nullable(),
      steps: z.array(z.object({ name: z.string(), conclusion: z.string().nullable(), number: z.number().int() })).optional(),
    }),
  ),
});

export interface CiSummary {
  /** Untrusted text, at most MAX_CI_SUMMARY_CHARS. Exactly what is scanned and shown to the reviewer. */
  text: string;
  /** Something was cut (job list, a log, or the whole). */
  truncated: boolean;
  /** Fixed-text problems reading it (e.g. a log that couldn't be fetched). */
  problems: string[];
}

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/gm;
const oneLine = (s: string, max = MAX_NAME) => {
  const flat = stripControlChars(s).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
/** Untrusted log text: control characters (incl. ANSI escapes) out, timestamps off, secrets masked. */
const cleanLog = (s: string) => maskSecrets(stripControlChars(s).replace(TIMESTAMP, "")).text;

/** Keeps the last `max` characters, starting at a line boundary when one is near. */
function tail(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let t = text.slice(text.length - max);
  const nl = t.indexOf("\n");
  if (nl !== -1 && nl < 200) t = t.slice(nl + 1);
  return { text: t, cut: true };
}

/**
 * A summary of one CI run: its jobs and steps with their conclusions, then the end of each job's log. Every
 * part has its own cap and the whole is cut to MAX_CI_SUMMARY_CHARS here, so the scan sees exactly what the
 * reviewer sees and a huge log never reaches the scan's size limit. Logs that can't be fetched are noted, not
 * fatal.
 */
export async function readCiSummary(gh: GitHubClient, repo: string, runId: number): Promise<CiSummary> {
  const problems: string[] = [];
  const { jobs: allJobs } = await gh.request("GET", `/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`, undefined, JobsSchema);
  const jobs = allJobs.slice(0, MAX_JOBS);
  let truncated = allJobs.length > jobs.length;

  let list = `CI run ${runId}: ${jobs.length} job(s)${truncated ? ` (first ${MAX_JOBS} of ${allJobs.length})` : ""}\n`;
  for (const j of jobs) {
    list += `- ${oneLine(j.name)}: ${oneLine(j.conclusion ?? "unknown", 20)}\n`;
    for (const s of j.steps ?? []) list += `  - ${oneLine(s.name)}: ${oneLine(s.conclusion ?? "unknown", 20)}\n`;
  }
  const cutList = list.length > MAX_JOB_LIST_CHARS;
  if (cutList) list = `${list.slice(0, MAX_JOB_LIST_CHARS)}\n[job list truncated]\n`;
  truncated ||= cutList;

  const share = Math.max(MIN_TAIL_CHARS, Math.floor((MAX_CI_SUMMARY_CHARS - list.length) / Math.max(1, jobs.length)) - 120);
  let logs = "";
  for (const j of jobs) {
    let body: string;
    let cut: boolean;
    try {
      const d = await gh.download(`/repos/${repo}/actions/jobs/${j.id}/logs`, { maxBytes: MAX_LOG_BYTES, keep: "tail" });
      body = cleanLog(d.data.toString("utf8"));
      cut = d.truncated;
    } catch {
      problems.push(`log of job ${j.id} unavailable`);
      continue;
    }
    const t = tail(body.trimEnd(), share);
    cut ||= t.cut;
    truncated ||= cut;
    logs += `\n=== end of log: ${oneLine(j.name)}${cut ? " (earlier output cut)" : ""} ===\n${t.text}\n`;
  }
  let text = `${list}${logs}`;
  if (text.length > MAX_CI_SUMMARY_CHARS) {
    text = `${text.slice(0, MAX_CI_SUMMARY_CHARS - 40)}\n[CI summary truncated]\n`;
    truncated = true;
  }
  return { text, truncated, problems };
}

// ---- Screenshots from a CI artifact ----

/** The CI artifact holding the smoke test's screenshots (the web-app profile's verify step). */
export const SCREENSHOT_ARTIFACT = "smoke";
/** Only PNGs under this top-level directory of the artifact are used. */
export const SCREENSHOT_DIR = "screenshots/";
/** The zipped artifact as downloaded. */
export const MAX_ARTIFACT_ZIP_BYTES = 50 * 1024 * 1024;
const SCREENSHOT_ZIP_LIMITS: ZipLimits = { maxEntries: 5000, maxEntryBytes: 10 * 1024 * 1024, maxTotalBytes: 60 * 1024 * 1024 };
/** runner MAX_REVIEW_SCREENSHOTS. */
export const MAX_SCREENSHOTS = 20;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ArtifactsSchema = z.object({
  artifacts: z.array(z.object({ id: z.number().int().positive(), name: z.string(), size_in_bytes: z.number().int().nonnegative(), expired: z.boolean() })),
});

export interface Screenshots {
  /** A fresh, realpath'd directory holding the PNGs under harness names; the caller removes it. Null when none. */
  dir: string | null;
  /** Local files and their untrusted labels (the artifact's entry names), for startReview. */
  files: { path: string; label: string }[];
  problems: string[];
}

/**
 * Downloads the CI run's screenshot artifact and extracts its PNGs (at most MAX_SCREENSHOTS, sorted by name)
 * under harness-assigned names in a new directory, which is realpath'd so the runner's canonical-path check
 * holds (macOS tmp is a symlink). The zip is parsed in memory by readZip: no symlinks, special files,
 * traversal, duplicates or oversized entries. Any problem means no screenshots, never a failed review.
 */
export async function readCiScreenshots(gh: GitHubClient, repo: string, runId: number, artifact = SCREENSHOT_ARTIFACT): Promise<Screenshots> {
  const none = (problem?: string): Screenshots => ({ dir: null, files: [], problems: problem ? [problem] : [] });
  const { artifacts } = await gh.request("GET", `/repos/${repo}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(artifact)}&per_page=10`, undefined, ArtifactsSchema);
  const found = artifacts.filter((a) => a.name === artifact && !a.expired);
  if (found.length === 0) return none();
  if (found.length > 1) return none("more than one screenshot artifact");
  if (found[0]!.size_in_bytes > MAX_ARTIFACT_ZIP_BYTES) return none("screenshot artifact too large");
  const zip = await gh.download(`/repos/${repo}/actions/artifacts/${found[0]!.id}/zip`, { maxBytes: MAX_ARTIFACT_ZIP_BYTES });
  if (zip.truncated) return none("screenshot artifact too large");

  let entries;
  try {
    entries = readZip(zip.data, (name) => name.startsWith(SCREENSHOT_DIR) && name.toLowerCase().endsWith(".png"), SCREENSHOT_ZIP_LIMITS);
  } catch (err) {
    return none(`screenshot artifact refused: ${(err as Error).message}`);
  }
  const pngs = entries.filter((e) => e.data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).sort((a, b) => (a.name < b.name ? -1 : 1));
  const problems = pngs.length < entries.length ? ["some screenshot entries are not PNGs"] : [];
  if (pngs.length > MAX_SCREENSHOTS) problems.push(`only the first ${MAX_SCREENSHOTS} screenshots are used`);
  const chosen = pngs.slice(0, MAX_SCREENSHOTS);
  if (chosen.length === 0) return { dir: null, files: [], problems };

  const dir = await realpath(await mkdtemp(join(tmpdir(), "globalhost-ci-shots-")));
  try {
    const files: Screenshots["files"] = [];
    for (const [i, e] of chosen.entries()) {
      const path = join(dir, `ci-${String(i + 1).padStart(2, "0")}.png`);
      await writeFile(path, e.data, { flag: "wx", mode: 0o600 });
      files.push({ path, label: e.name.slice(SCREENSHOT_DIR.length) });
    }
    return { dir, files, problems };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

// ---- The diff, for the scan and the Finding.file check ----

export interface DiffInfo {
  /** Every path the diff touches (added, modified, deleted; renames as delete + add). */
  paths: string[];
  addedLines: AddedLine[];
  commitMessages: string[];
  /** `git patch-id --stable` of merge-base..head; UNKNOWN_PATCH_ID for an empty diff. */
  patchId: string;
}

/** Stands in for a patch ID when there is none (an empty diff, or a review that never read the diff). */
export const UNKNOWN_PATCH_ID = "0".repeat(40);
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const MAX_COMMITS = 1000;

/** git with hooks, user and system config off, capturing stdout as bytes; `input` is written to stdin. */
export function gitBytes(cwd: string, args: readonly string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false", ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > MAX_GIT_OUTPUT) child.kill("SIGKILL");
      else out.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      if (err.length < 2000) err += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (size > MAX_GIT_OUTPUT) reject(new Error(`git ${args[0]}: output over ${MAX_GIT_OUTPUT} bytes`));
      else if (code !== 0) reject(new Error(`git ${args[0]} exited ${code}: ${err.trim().slice(0, 300)}`));
      else resolve(Buffer.concat(out));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses `git diff -U0` output into added lines. File sections are matched to `paths` by order (git prints
 * both in the same order), so a quoted or odd path name never has to be parsed out of a header.
 */
export function parseAddedLines(diff: string, paths: readonly string[]): AddedLine[] {
  const lines = diff.split("\n");
  const out: AddedLine[] = [];
  let file = -1;
  let inHunk = false;
  let next = 0;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      file++;
      inHunk = false;
      continue;
    }
    if (file < 0) continue;
    const h = HUNK.exec(line);
    if (h) {
      inHunk = true;
      next = Number(h[1]);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) out.push({ file: paths[file] ?? "", line: next++, text: line.slice(1) });
    else if (line.startsWith(" ")) next++;
  }
  if (file + 1 !== paths.length) throw new Error(`diff has ${file + 1} file sections for ${paths.length} paths`);
  return out;
}

/** Reads the PR's diff (merge-base..head) from a bare repo that holds both commits. */
export async function readDiff(bareDir: string, mergeBaseSha: string, headSha: string): Promise<DiffInfo> {
  const range = [mergeBaseSha, headSha];
  const names = (await gitBytes(bareDir, ["diff", "--name-only", "-z", "--no-renames", ...range])).toString("utf8");
  const paths = names.split("\0").filter(Boolean);
  const common = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
  const patch = await gitBytes(bareDir, ["diff", ...common, "--unified=0", ...range]);
  const addedLines = parseAddedLines(patch.toString("utf8"), paths);
  const log = (await gitBytes(bareDir, ["log", "-z", `--max-count=${MAX_COMMITS}`, "--format=%B", `${mergeBaseSha}..${headSha}`])).toString("utf8");
  const commitMessages = log.split("\0").filter((m) => m.length > 0);
  const full = await gitBytes(bareDir, ["diff", ...common, ...range]);
  const pid = full.length === 0 ? "" : (await gitBytes(bareDir, ["patch-id", "--stable"], full)).toString("utf8").trim().split(/\s+/)[0] ?? "";
  return { paths, addedLines, commitMessages, patchId: /^[0-9a-f]{40}$/.test(pid) ? pid : UNKNOWN_PATCH_ID };
}
