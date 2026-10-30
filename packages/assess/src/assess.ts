// `globalhost assess` end to end (PLAN P1-08, ONBOARDING Stage 1): trusted checks → assessor session →
// one onboarding issue body. Nothing here writes to GitHub; postIssue is called separately, and only on --post.
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EnvironmentSpec, Profile, Registry } from "@globalhost/core";
import type { GitHubClient } from "@globalhost/dispatch";
import type { AssessSpec, RunRecord } from "@globalhost/runner";
import { z } from "zod";
import { gatherFacts, type AssessmentFacts, type GatherDeps } from "./facts.js";
import { checkAgentFactoryYaml, proposeFactoryYaml, type Owner, type Proposal, type ReleaseProposer } from "./proposal.js";
import { AssessorReadinessSchema, combineReadiness, factScores, type Readiness } from "./readiness.js";
import { issueBody, issueTitle, promptFacts, type IssueInput } from "./render.js";

export interface AssessInput {
  runId: string;
  repo: string;
  profiles: readonly Profile[];
  registry: Registry;
  outDir: string;
  budgetUsd: number;
  timeoutMinutes: number;
  gcpProject?: string;
  owners?: Owner[];
  /** Owner-authored open items to raise (e.g. from an ADR). */
  ownerNotes?: string;
  proposeRelease?: ReleaseProposer;
  model?: string;
  skillDirs?: string[];
}

export interface AssessDeps extends GatherDeps {
  /** startAssessment from the runner, bound to its deps. */
  runAssessor: (spec: AssessSpec) => Promise<RunRecord>;
}

export interface AssessResult {
  record: RunRecord;
  facts: AssessmentFacts;
  readiness: Readiness;
  proposal: Proposal;
  title: string;
  body: string;
  /** Harness problems with the agent's extra outputs (readiness, factory.yaml). */
  problems: string[];
}

const ReadinessReportSchema = z.object({ readiness: AssessorReadinessSchema.optional() });

/** The run's network environment: the proposed parts' profiles' environments, merged (as for issue runs). */
function environmentFor(profiles: readonly Profile[], ids: readonly string[]): EnvironmentSpec | undefined {
  const used = profiles.filter((p) => ids.includes(p.id));
  if (used.length === 0) return undefined;
  if (used.length === 1) return used[0]!.environment;
  return {
    name: `globalhost-${used.map((p) => p.id).sort().join("-")}`,
    allowedHosts: [...new Set(used.flatMap((p) => p.environment.allowedHosts))].sort(),
  };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function assess(input: AssessInput, deps: AssessDeps): Promise<AssessResult> {
  const facts = await gatherFacts({ repo: input.repo, profiles: input.profiles, gcpProject: input.gcpProject }, deps);
  const scored = factScores(facts);
  const proposal = proposeFactoryYaml({
    facts,
    profiles: input.profiles,
    registry: input.registry,
    owners: input.owners,
    proposeRelease: input.proposeRelease,
  });
  if (proposal.errors.length) deps.log(`the proposed factory.yaml has ${proposal.errors.length} validation error(s); they're listed in the issue`);

  const record = await deps.runAssessor({
    runId: input.runId,
    repo: input.repo,
    budgetUsd: input.budgetUsd,
    timeoutMinutes: input.timeoutMinutes,
    outDir: input.outDir,
    model: input.model,
    environment: environmentFor(input.profiles, facts.stack.proposed.map((p) => p.profile)),
    skillDirs: input.skillDirs,
    facts: promptFacts(facts, scored, proposal),
    ownerNotes: input.ownerNotes,
  });

  // The agent's raw outputs keep their names with an .agent suffix; assessment.md becomes the composed issue body.
  const problems: string[] = [];
  const out = (name: string) => join(input.outDir, name);
  const agentMarkdown = await readOptional(out("assessment.md"));
  if (agentMarkdown !== undefined) await rename(out("assessment.md"), out("assessment.agent.md"));

  let agentReadiness;
  const reportText = await readOptional(out("report.json"));
  if (reportText !== undefined) {
    try {
      agentReadiness = ReadinessReportSchema.parse(JSON.parse(reportText)).readiness;
    } catch {
      problems.push("report.json readiness is not in the expected shape; the assessor's scores were ignored");
    }
  }

  let agentYaml: IssueInput["agentYaml"];
  const yamlText = await readOptional(out("factory.yaml"));
  if (yamlText !== undefined) {
    await rename(out("factory.yaml"), out("factory.agent.yaml"));
    const checked = checkAgentFactoryYaml(yamlText, input.registry, proposal);
    agentYaml = checked.ok ? { ok: true, text: yamlText } : checked;
    if (!checked.ok) problems.push(`the assessor's factory.yaml was rejected: ${checked.errors.join("; ")}`);
  }

  const readiness = combineReadiness(scored, agentReadiness);
  const title = issueTitle(facts.github.repo);
  const body = issueBody({
    facts,
    readiness,
    proposal,
    agentYaml,
    agentMarkdown,
    ownerNotes: input.ownerNotes,
    run: { runId: record.runId, sessionId: record.sessionId, status: record.status, costUsd: record.costUsd },
  });

  await writeFile(out("assessment.md"), body);
  await writeFile(out("factory.proposed.yaml"), agentYaml?.ok ? agentYaml.text : proposal.text);
  await writeFile(out("facts.json"), `${JSON.stringify(facts, null, 2)}\n`);
  await writeFile(out("assessment.json"), `${JSON.stringify({ title, readiness, proposal: { errors: proposal.errors, notes: proposal.notes }, problems }, null, 2)}\n`);
  return { record, facts, readiness, proposal, title, body, problems };
}

/** Opens the onboarding issue with the owner's token. The body is already postable (issueBody). */
export async function postIssue(gh: GitHubClient, repo: string, title: string, body: string): Promise<{ number: number; url: string }> {
  const created = await gh.request("POST", `/repos/${repo}/issues`, { title, body }, z.object({ number: z.number().int(), html_url: z.string() }));
  return { number: created.number, url: created.html_url };
}
