// Shared fixtures for the review gate and step tests: workflow_run and label events, and a factory PR.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOT, FakeCloud, OWNER, REPO } from "./fakes.js";

export const HEAD = "1111111111111111111111111111111111111111";
export const BASE = "2222222222222222222222222222222222222222";
export const PR = 7;
export const ISSUE = 12;
export const CI_RUN = 555;
export const BRANCH = `factory/issue-${ISSUE}`;

export interface PullOverrides {
  state?: string;
  user?: { login: string; id: number; type: string };
  headRef?: string;
  headSha?: string;
  headRepo?: string | null;
  baseRef?: string;
  baseRepo?: string;
  title?: string;
  body?: string | null;
}

export function pull(o: PullOverrides = {}) {
  return {
    number: PR,
    state: o.state ?? "open",
    title: o.title ?? "Add the thing",
    body: o.body === undefined ? "Closes #12" : o.body,
    user: o.user ?? BOT,
    head: { ref: o.headRef ?? BRANCH, sha: o.headSha ?? HEAD, repo: o.headRepo === null ? null : { full_name: o.headRepo ?? REPO } },
    base: { ref: o.baseRef ?? "main", sha: BASE, repo: { full_name: o.baseRepo ?? REPO } },
  };
}

export interface RunOverrides {
  name?: string;
  path?: string;
  event?: string;
  conclusion?: string | null;
  status?: string;
  headSha?: string;
  headBranch?: string | null;
  headRepo?: string | null;
  actor?: { login: string; id: number; type: string };
  triggeringActor?: { login: string; id: number; type: string } | null;
  id?: number;
}

export function ciRun(o: RunOverrides = {}) {
  return {
    id: o.id ?? CI_RUN,
    name: o.name ?? "globalhost-ci",
    path: o.path ?? ".github/workflows/globalhost-ci.yml",
    event: o.event ?? "pull_request",
    status: o.status ?? "completed",
    conclusion: o.conclusion === undefined ? "success" : o.conclusion,
    head_sha: o.headSha ?? HEAD,
    head_branch: o.headBranch === undefined ? BRANCH : o.headBranch,
    head_repository: o.headRepo === null ? null : { full_name: o.headRepo ?? REPO },
    actor: o.actor ?? BOT,
    triggering_actor: o.triggeringActor === undefined ? BOT : o.triggeringActor,
  };
}

export const workflowRunEvent = (o: RunOverrides = {}, action = "completed") => ({ action, workflow_run: ciRun(o), sender: BOT });

export const labelEvent = (o: { label?: string; sender?: { login: string; id: number; type: string }; action?: string } = {}) => ({
  action: o.action ?? "labeled",
  label: { name: o.label ?? "factory:review" },
  sender: o.sender ?? OWNER,
  pull_request: { number: PR },
});

/** Routes for the PR lookups both trigger paths make. */
export function routePull(cloud: FakeCloud, p = pull(), runs = [ciRun()]) {
  cloud.routes.set(`GET /repos/${REPO}/pulls?state=open&head=${encodeURIComponent(`anlinguist:${BRANCH}`)}&base=main&per_page=10`, [p]);
  cloud.routes.set(`GET /repos/${REPO}/pulls/${PR}`, p);
  cloud.routes.set(`GET /repos/${REPO}/actions/workflows/globalhost-ci.yml/runs?head_sha=${p.head.sha}&event=pull_request&status=success&per_page=20`, {
    workflow_runs: runs,
  });
}

export function eventFile(event: object): string {
  const path = join(mkdtempSync(join(tmpdir(), "event-")), "event.json");
  writeFileSync(path, JSON.stringify(event));
  return path;
}
