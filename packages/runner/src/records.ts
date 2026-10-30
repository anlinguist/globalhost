// run.json and the agent's report.json. run.json is written by the harness (trusted). report.json is
// written by the agent, so it's untrusted: it's parsed strictly, capped, and only ever shown as data.
import { z } from "zod";

// Agent-written text is clipped, not rejected: one over-long check name shouldn't fail a run that did the work.
const text = (max: number) => z.string().transform((s) => (s.length > max ? `${s.slice(0, max - 1)}…` : s));

export const AgentReportSchema = z
  .object({
    outcome: z.enum(["done", "blocked", "failed"]),
    summary: text(4000),
    acceptanceTests: z
      .array(
        z.object({
          name: text(300),
          file: text(300).optional(),
          status: z.enum(["planned", "added"]),
          failsOnBase: z.boolean().optional(),
        }),
      )
      .max(50)
      .default([]),
    checks: z
      .array(z.object({ name: text(100), command: text(300), passed: z.boolean() }))
      .max(50)
      .default([]),
    questions: z.array(text(1000)).max(20).default([]),
    notes: text(4000).optional(),
  })
  .strip();
export type AgentReport = z.infer<typeof AgentReportSchema>;

export const RUN_STATUSES = ["succeeded", "blocked", "failed", "cap_exceeded", "timeout"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const BundleSummarySchema = z.object({
  sha256: z.string(),
  bytes: z.number().int(),
  branch: z.string(),
  headSha: z.string(),
  commits: z.number().int(),
  filesChanged: z.array(z.string()),
});
export type BundleSummary = z.infer<typeof BundleSummarySchema>;

export const RunRecordSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  role: z.enum(["planner", "builder", "assessor"]),
  repo: z.string(),
  /** The issue the run works on; null for an assessment, which covers the whole repo. */
  issue: z.number().int().nullable(),
  baseSha: z.string(),
  sessionId: z.string(),
  agent: z.object({ id: z.string(), version: z.number().int() }),
  environmentId: z.string(),
  model: z.string(),
  /** How many messages this session has handled; >1 means it was resumed with owner feedback. */
  turn: z.number().int().min(1),
  status: z.enum(RUN_STATUSES),
  /** The session's last idle stop reason, or the harness's reason when it stopped waiting. */
  stopReason: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  wallSeconds: z.number(),
  activeSeconds: z.number().nullable(),
  /** Session list cost so far, in USD (all turns). */
  costUsd: z.number(),
  budgetUsd: z.number(),
  outputs: z.object({
    bundle: BundleSummarySchema.optional(),
    planBytes: z.number().int().optional(),
    assessmentBytes: z.number().int().optional(),
    /** The assessor's optional factory.yaml; the caller validates it before using it. */
    factoryYamlBytes: z.number().int().optional(),
  }),
  report: AgentReportSchema.optional(),
  /** Harness-side problems with the outputs (missing, oversized, invalid). */
  problems: z.array(z.string()),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
