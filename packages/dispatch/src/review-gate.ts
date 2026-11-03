// The review trigger (P2-01, shadow mode): decides from a workflow_run or pull_request_target event whether
// the PR head gets an automated review. Two ways in:
//   - CI success: `globalhost-ci` completed with success for a pull_request event on a factory PR's head.
//   - Owner request: an owner applies `factory:review` to a factory PR (a re-review of its current head, which
//     must have passed CI too). Only this path may re-review a SHA that was already reviewed.
// A factory PR is a same-repo PR from `factory/issue-<n>` into the default branch, opened by the App's bot.
// Everything is read fresh from the API; the event only says where to look. The review job runs this again
// with its own reads instead of trusting the gate job's outputs.
import { z } from "zod";
import type { GitHubClient } from "./github.js";

export const REVIEW_LABEL = "factory:review";
/** The CI workflow whose success triggers a review: its `name:` and its file. */
export const CI_WORKFLOW_NAME = "globalhost-ci";
export const CI_WORKFLOW_FILE = "globalhost-ci.yml";
const CI_WORKFLOW_PATH = `.github/workflows/${CI_WORKFLOW_FILE}`;

const FACTORY_BRANCH = /^factory\/issue-([1-9][0-9]{0,9})$/;
const SHA40 = /^[0-9a-f]{40}$/;

const ActorSchema = z.object({ id: z.number().int(), login: z.string(), type: z.string() });
type Actor = z.infer<typeof ActorSchema>;

const WorkflowRunSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().nullable(),
  path: z.string(),
  event: z.string(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  head_sha: z.string(),
  head_branch: z.string().nullable(),
  head_repository: z.object({ full_name: z.string() }).nullable(),
  actor: ActorSchema,
  triggering_actor: ActorSchema.nullable().optional(),
});
type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

const WorkflowRunEventSchema = z.object({ action: z.string(), workflow_run: WorkflowRunSchema });
const LabelEventSchema = z.object({
  action: z.string(),
  label: z.object({ name: z.string() }).optional(),
  sender: ActorSchema,
  pull_request: z.object({ number: z.number().int().positive() }),
});

export const ReviewPullSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  user: ActorSchema,
  head: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }) }),
});
export type ReviewPull = z.infer<typeof ReviewPullSchema>;

export interface ReviewTarget {
  pr: number;
  /** The head to review: the CI run's head, which the PR's head must equal. */
  sha: string;
  /** From the head branch `factory/issue-<n>`. */
  issue: number;
  /** The successful `globalhost-ci` run on `sha`. */
  ciRunId: number;
  /** Only for an owner's factory:review. */
  rereview: boolean;
  /** Came from factory:review (the label is removed once acted on). */
  viaLabel: boolean;
  pull: ReviewPull;
}

export type ReviewDecision =
  | { action: "review"; target: ReviewTarget }
  /** `unlabel`: an owner's factory:review on this PR that won't be acted on; remove the label so it can be re-applied. */
  | { action: "ignore"; reason: string; unlabel?: number };

export interface ReviewGateContext {
  gh: GitHubClient;
  repo: string;
  eventName: string;
  /** The parsed event payload (GITHUB_EVENT_PATH). */
  event: unknown;
  ownerIds: readonly number[];
  /** `<GLOBALHOST_APP_SLUG>[bot]`. */
  botLogin: string;
  defaultBranch: string;
}

const sameRepo = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b.toLowerCase();
const isBot = (a: Actor, botLogin: string) => a.type === "Bot" && a.login === botLogin;
const isOwner = (a: Actor, ownerIds: readonly number[]) => a.type === "User" && ownerIds.includes(a.id);

/** Why a run can't stand for "CI passed on this head", or null when it can. */
function ciRunProblem(run: WorkflowRun, ctx: ReviewGateContext): string | null {
  if (run.name !== CI_WORKFLOW_NAME || run.path !== CI_WORKFLOW_PATH) return "not the globalhost-ci workflow";
  if (run.event !== "pull_request") return `CI ran for a ${run.event} event, not pull_request`;
  if (run.status !== "completed" || run.conclusion !== "success") return "CI did not succeed";
  if (!sameRepo(run.head_repository?.full_name, ctx.repo)) return "CI ran on a fork";
  if (!SHA40.test(run.head_sha)) return "CI head is not a 40-hex SHA";
  const actors = [run.actor, ...(run.triggering_actor ? [run.triggering_actor] : [])];
  if (!actors.every((a) => isBot(a, ctx.botLogin) || isOwner(a, ctx.ownerIds))) return "CI was triggered by someone other than the factory bot or an owner";
  return null;
}

/** Why a PR isn't a reviewable factory PR at `sha`, or null when it is. */
export function pullProblem(pull: ReviewPull, sha: string, ctx: Pick<ReviewGateContext, "repo" | "botLogin" | "defaultBranch">): string | null {
  if (pull.state !== "open") return "the PR is not open";
  if (!sameRepo(pull.head.repo?.full_name, ctx.repo)) return "the PR is from a fork";
  if (!FACTORY_BRANCH.test(pull.head.ref)) return "the PR's head branch is not factory/issue-<n>";
  if (!isBot(pull.user, ctx.botLogin)) return "the PR was not opened by the factory bot";
  if (pull.base.ref !== ctx.defaultBranch || !sameRepo(pull.base.repo.full_name, ctx.repo)) return "the PR does not target the default branch";
  if (pull.head.sha !== sha) return "the PR head moved since CI ran";
  return null;
}

/** Decides whether to review, from the event and fresh reads. Pure apart from GitHub GETs. */
export async function decideReview(ctx: ReviewGateContext): Promise<ReviewDecision> {
  const { gh, repo } = ctx;
  if (ctx.eventName === "workflow_run") {
    const parsed = WorkflowRunEventSchema.safeParse(ctx.event);
    if (!parsed.success) return { action: "ignore", reason: "unrecognised workflow_run event" };
    const run = parsed.data.workflow_run;
    if (parsed.data.action !== "completed") return { action: "ignore", reason: "workflow run not completed" };
    const problem = ciRunProblem(run, ctx);
    if (problem) return { action: "ignore", reason: problem };
    const branch = run.head_branch ?? "";
    if (!FACTORY_BRANCH.test(branch)) return { action: "ignore", reason: "not a factory/issue-<n> branch" };
    const owner = repo.split("/")[0]!;
    const pulls = await gh.request(
      "GET",
      `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(ctx.defaultBranch)}&per_page=10`,
      undefined,
      z.array(ReviewPullSchema),
    );
    if (pulls.length !== 1) return { action: "ignore", reason: pulls.length === 0 ? "no open PR for this branch" : "more than one open PR for this branch" };
    const pull = pulls[0]!;
    const bad = pullProblem(pull, run.head_sha, ctx);
    if (bad) return { action: "ignore", reason: bad };
    return { action: "review", target: target(pull, run.head_sha, run.id, false, false) };
  }

  if (ctx.eventName === "pull_request_target") {
    const parsed = LabelEventSchema.safeParse(ctx.event);
    if (!parsed.success) return { action: "ignore", reason: "unrecognised pull_request_target event" };
    const e = parsed.data;
    if (e.action !== "labeled" || e.label?.name !== REVIEW_LABEL) return { action: "ignore", reason: `not a ${REVIEW_LABEL} label event` };
    // A non-owner's label is left alone: removing it would let anyone with triage make the bot act.
    if (!isOwner(e.sender, ctx.ownerIds)) return { action: "ignore", reason: `${REVIEW_LABEL} applied by a non-owner` };
    const pr = e.pull_request.number;
    const refuse = (reason: string): ReviewDecision => ({ action: "ignore", reason, unlabel: pr });
    const pull = await gh.request("GET", `/repos/${repo}/pulls/${pr}`, undefined, ReviewPullSchema);
    if (!SHA40.test(pull.head.sha)) return refuse("the PR head is not a 40-hex SHA");
    const bad = pullProblem(pull, pull.head.sha, ctx);
    if (bad) return refuse(bad);
    const ciRunId = await successfulCiRun(ctx, pull.head.sha);
    if (ciRunId === null) return refuse("globalhost-ci has not succeeded on the PR head");
    return { action: "review", target: target(pull, pull.head.sha, ciRunId, true, true) };
  }

  return { action: "ignore", reason: `unsupported event ${ctx.eventName}` };
}

const RunsSchema = z.object({ workflow_runs: z.array(WorkflowRunSchema) });

/** The newest successful `globalhost-ci` pull_request run on `sha` that passes the same checks as the trigger. */
async function successfulCiRun(ctx: ReviewGateContext, sha: string): Promise<number | null> {
  const { workflow_runs } = await ctx.gh.request(
    "GET",
    `/repos/${ctx.repo}/actions/workflows/${CI_WORKFLOW_FILE}/runs?head_sha=${sha}&event=pull_request&status=success&per_page=20`,
    undefined,
    RunsSchema,
  );
  const ok = workflow_runs.filter((r) => r.head_sha === sha && ciRunProblem(r, ctx) === null).sort((a, b) => b.id - a.id);
  return ok[0]?.id ?? null;
}

function target(pull: ReviewPull, sha: string, ciRunId: number, rereview: boolean, viaLabel: boolean): ReviewTarget {
  const issue = Number(FACTORY_BRANCH.exec(pull.head.ref)![1]);
  return { pr: pull.number, sha, issue, ciRunId, rereview, viaLabel, pull };
}
