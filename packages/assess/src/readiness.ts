// The agent-readiness score (ONBOARDING §1, 100 points). Trusted code scores the items the facts decide; the
// assessor scores the rest from what it verified in its sandbox. For an item the facts decide, the facts win.
//
// Scored from facts:
//   ci       5 when a GitHub workflow is active or a Cloud Build trigger runs on pull requests; 0 when neither
//            exists and GCP was checked (without --gcp-project a PR trigger could exist, so the assessor decides)
//   secrets  0 on any gitleaks finding; 10 when gitleaks ran clean and no credential-shaped file was ever
//            committed; otherwise (gitleaks not run, or only credential-shaped names) the assessor decides
//   docs     5 when CLAUDE.md or AGENTS.md is at the root; otherwise the assessor judges the README
//   testsExist 0 when no test-like file exists; otherwise the assessor checks that they're real and run
// Always the assessor's: build, typecheckLint, testsCritical, localDev, nonProd.
import { z } from "zod";
import type { AssessmentFacts } from "./facts.js";

export const RUBRIC = [
  { id: "build", max: 15, label: "Builds from clean checkout" },
  { id: "typecheckLint", max: 10, label: "Typecheck/lint configured" },
  { id: "testsExist", max: 15, label: "Automated tests exist" },
  { id: "testsCritical", max: 15, label: "Tests cover critical paths" },
  { id: "localDev", max: 10, label: "Reproducible local dev / seed data" },
  { id: "nonProd", max: 15, label: "Non-prod environment separate from prod data" },
  { id: "docs", max: 5, label: "Docs / CLAUDE.md" },
  { id: "secrets", max: 10, label: "No live secrets in repo/history" },
  { id: "ci", max: 5, label: "CI exists" },
] as const;

export type ReadinessId = (typeof RUBRIC)[number]["id"];
const IDS = RUBRIC.map((r) => r.id) as [ReadinessId, ...ReadinessId[]];

/** The assessor's `readiness` entries in report.json (agent-written: parsed strictly, clamped later). */
export const AssessorReadinessSchema = z
  .array(z.object({ id: z.enum(IDS), points: z.number().int().min(0).max(15), evidence: z.string().max(500) }))
  .max(20);
export type AssessorReadiness = z.infer<typeof AssessorReadinessSchema>;

export interface Scored {
  points: number;
  evidence: string;
}

export interface ReadinessItem {
  id: ReadinessId;
  label: string;
  max: number;
  /** null when nobody could score it; it counts as 0. */
  points: number | null;
  source: "facts" | "assessor" | "unscored";
  evidence: string;
}

export interface Readiness {
  total: number;
  items: ReadinessItem[];
}

export function factScores(f: AssessmentFacts): Partial<Record<ReadinessId, Scored>> {
  const out: Partial<Record<ReadinessId, Scored>> = {};

  const active = f.github.workflows.ok ? f.github.workflows.items.filter((w) => w.state === "active").length : undefined;
  const prTriggers = f.gcp?.triggers.ok ? f.gcp.triggers.items.filter((t) => !t.disabled && t.pullRequestBranch).length : undefined;
  if ((active ?? 0) > 0) out.ci = { points: 5, evidence: `${active} active GitHub workflow(s)` };
  else if ((prTriggers ?? 0) > 0) out.ci = { points: 5, evidence: `${prTriggers} Cloud Build trigger(s) run on pull requests` };
  else if (active === 0 && prTriggers === 0) out.ci = { points: 0, evidence: "no active GitHub workflows and no pull-request Cloud Build triggers" };

  const gl = f.secrets.gitleaks;
  if (gl.status === "ran" && gl.findings.length > 0) out.secrets = { points: 0, evidence: `gitleaks: ${gl.findings.length}${gl.truncated ? "+" : ""} finding(s) in history` };
  else if (gl.status === "ran" && f.secrets.credentialFiles.length === 0) {
    out.secrets = { points: 10, evidence: "gitleaks found nothing in any branch's history; no credential-shaped files ever committed" };
  }

  if (f.docs.agentDocs.length > 0) out.docs = { points: 5, evidence: `${f.docs.agentDocs.join(", ")} at the root` };
  if (f.tests.count === 0) out.testsExist = { points: 0, evidence: "no test-like files on the default branch" };
  return out;
}

export function combineReadiness(facts: Partial<Record<ReadinessId, Scored>>, assessor: AssessorReadiness | undefined): Readiness {
  const byId = new Map((assessor ?? []).map((a) => [a.id, a]));
  const items = RUBRIC.map((r): ReadinessItem => {
    const fact = facts[r.id];
    if (fact) return { id: r.id, label: r.label, max: r.max, points: Math.min(fact.points, r.max), source: "facts", evidence: fact.evidence };
    const a = byId.get(r.id);
    if (a) return { id: r.id, label: r.label, max: r.max, points: Math.min(a.points, r.max), source: "assessor", evidence: a.evidence };
    return { id: r.id, label: r.label, max: r.max, points: null, source: "unscored", evidence: "not assessed" };
  });
  return { total: items.reduce((n, i) => n + (i.points ?? 0), 0), items };
}
