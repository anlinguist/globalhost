// Stack & parts: every registered profile's detect() on the repo root and each directory two levels down, over a
// read-only snapshot. Profiles come from the caller (the CLI), so this module names none of them.
import type { Profile, RepoSnapshot } from "@globalhost/core";

export interface PartFinding {
  path: string;
  profile: string;
  confidence: number;
  /** Human-readable, may quote repo file names: untrusted when rendered. */
  evidence: string[];
  suggestedConfig: unknown;
}

export interface StackFacts {
  /** Every (path, profile) pair that scored at least REPORT_THRESHOLD, plus the root for each profile. */
  candidates: PartFinding[];
  /** Non-overlapping parts for the proposed factory.yaml, best first. */
  proposed: PartFinding[];
  /** True when nothing reached PROPOSE_THRESHOLD and the proposal fell back to the best guess. */
  lowConfidence: boolean;
}

/** ONBOARDING / PROFILES: below 0.5 the assessment asks the owner instead of proposing. */
export const PROPOSE_THRESHOLD = 0.5;
const REPORT_THRESHOLD = 0.3;
const MAX_DEPTH = 2;
const MAX_CANDIDATE_DIRS = 60;
const SKIP_DIR = /^(?:\.|_|node_modules$|dist$|build$|out$|vendor$|coverage$|public$|assets$|static$)/;

export function candidateDirs(files: readonly string[]): string[] {
  const dirs = new Set<string>(["."]);
  for (const f of files) {
    const segments = f.split("/").slice(0, -1);
    for (let depth = 1; depth <= Math.min(MAX_DEPTH, segments.length); depth++) {
      const parts = segments.slice(0, depth);
      if (parts.some((s) => SKIP_DIR.test(s))) break;
      dirs.add(parts.join("/"));
    }
  }
  return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).slice(0, MAX_CANDIDATE_DIRS);
}

const overlaps = (a: string, b: string) => a === "." || b === "." || a.toLowerCase() === b.toLowerCase() || b.toLowerCase().startsWith(`${a.toLowerCase()}/`) || a.toLowerCase().startsWith(`${b.toLowerCase()}/`);

export async function detectStack(profiles: readonly Profile[], snapshot: RepoSnapshot): Promise<StackFacts> {
  const all: PartFinding[] = [];
  for (const path of candidateDirs(snapshot.files)) {
    for (const profile of profiles) {
      const d = await profile.detect(snapshot, path);
      all.push({ path, profile: profile.id, confidence: d.confidence, evidence: d.evidence.slice(0, 10), suggestedConfig: d.suggestedConfig });
    }
  }
  const ranked = [...all].sort((a, b) => b.confidence - a.confidence || a.path.split("/").length - b.path.split("/").length);
  const proposed: PartFinding[] = [];
  for (const f of ranked) {
    if (f.confidence < PROPOSE_THRESHOLD) break;
    if (!proposed.some((p) => overlaps(p.path, f.path))) proposed.push(f);
  }
  const lowConfidence = proposed.length === 0;
  if (lowConfidence && ranked[0]) proposed.push(ranked[0]);
  return {
    candidates: all.filter((f) => f.confidence >= REPORT_THRESHOLD || f.path === "."),
    proposed,
    lowConfidence,
  };
}

/** Files that look like automated tests, by naming convention across common languages. */
export function testFiles(files: readonly string[]): string[] {
  return files.filter(
    (f) =>
      !/(?:^|\/)node_modules\//.test(f) &&
      (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f) ||
        /(?:^|\/)__tests__\/.+\.[cm]?[jt]sx?$/.test(f) ||
        /(?:^|\/)test_[^/]+\.py$/.test(f) ||
        /_test\.(?:py|go)$/.test(f) ||
        /(?:^|\/)(?:e2e|tests?)\/.+\.(?:[cm]?[jt]sx?|py|go|rb)$/.test(f)),
  );
}

/** Agent-facing docs at the repo root (the rubric's "docs/CLAUDE.md" item). */
export function agentDocs(files: readonly string[]): string[] {
  return files.filter((f) => /^(?:CLAUDE|AGENTS)\.md$/i.test(f));
}
