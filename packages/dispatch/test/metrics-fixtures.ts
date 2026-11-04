// Builders for what the nightly job reads: run.json files shaped by the runner's schemas, and spend records.
import { RunRecordSchema, ReviewRunSchema, type ReviewRun, type RunRecord } from "@globalhost/runner";
import type { StoredObject } from "../src/metrics.js";

export const PUBLIC_REPO = "anlinguist/numu-know";
export const SHA = "a".repeat(40);

export function runRecord(over: Partial<RunRecord> = {}): RunRecord {
  return RunRecordSchema.parse({
    version: 1,
    runId: "run-1",
    role: "builder",
    repo: PUBLIC_REPO,
    issue: 32,
    baseSha: "b".repeat(40),
    sessionId: "sesn_1",
    agent: { id: "agent_1", version: 1 },
    environmentId: "env_1",
    model: "claude-opus-5-5",
    turn: 1,
    status: "succeeded",
    stopReason: "end_turn",
    startedAt: "2026-11-02T10:00:00.000Z",
    finishedAt: "2026-11-02T10:30:00.000Z",
    wallSeconds: 1800,
    activeSeconds: 1200,
    costUsd: 1,
    budgetUsd: 4,
    outputs: {},
    problems: [],
    ...over,
  });
}

export function reviewRun(over: Partial<ReviewRun> = {}): ReviewRun {
  return ReviewRunSchema.parse({
    version: 1,
    kind: "review",
    runId: "review-1",
    repo: PUBLIC_REPO,
    pr: 38,
    issue: 32,
    headSha: SHA,
    baseSha: "b".repeat(40),
    mergeBaseSha: "c".repeat(40),
    sessionId: "sesn_r1",
    agent: { id: "agent_r", version: 1 },
    environmentId: "env_r",
    model: "claude-opus-5-5",
    status: "completed",
    stopReason: "end_turn",
    output: null,
    outputIssues: [],
    outputBytes: null,
    screenshots: [],
    startedAt: "2026-11-02T11:00:00.000Z",
    finishedAt: "2026-11-02T11:10:00.000Z",
    wallSeconds: 600,
    activeSeconds: 500,
    costUsd: 0.5,
    budgetUsd: 2,
    problems: [],
    ...over,
  });
}

/** `<repo>/<runId>/turn-<N>/run.json`: the repo's case as GITHUB_REPOSITORY has it. */
export const builderObject = (r: RunRecord): StoredObject => ({
  name: `${r.repo}/${r.runId}/turn-${r.turn}/run.json`,
  body: JSON.stringify(r),
});

/** `<lowercased repo>/reviews/pr-<n>/<sha>/<runId>/run.json`. */
export const reviewObject = (r: ReviewRun): StoredObject => ({
  name: `${r.repo.toLowerCase()}/reviews/pr-${r.pr}/${r.headSha}/${r.runId}/run.json`,
  body: JSON.stringify(r),
});

export const spendObject = (day: string, repo: string, record: unknown): StoredObject => ({
  name: `spend/${day}/${repo.replace("/", "__")}.json`,
  body: JSON.stringify(record),
});
