// Trust gate (ARCHITECTURE §2.3 step 1, ONBOARDING §3): only an owner's label or comment starts work,
// and owners are matched by immutable user ID, never by login. Pure, so every case is unit-testable.

export const START_LABELS = { "factory:plan": "planner", "factory:build": "builder" } as const;
export type StartLabel = keyof typeof START_LABELS;

export type GateEvent =
  | { kind: "label"; label: string; senderId: number; issue: number; isPullRequest: boolean }
  | {
      kind: "comment";
      senderId: number;
      senderType: string;
      /** For a comment on a PR: the PR number and its head branch. */
      pullRequest?: { number: number; headRef: string; headRepoIsBase: boolean };
      body: string;
    };

export type GateDecision =
  | { action: "ignore"; reason: string }
  | { action: "start"; role: "planner" | "builder"; issue: number }
  | { action: "resume"; role: "builder"; issue: number; pullRequest: number; feedback: string };

const FACTORY_BRANCH = /^factory\/issue-([1-9][0-9]{0,9})$/;

export function gate(event: GateEvent, ownerIds: readonly number[]): GateDecision {
  const owner = ownerIds.includes(event.senderId);
  if (event.kind === "label") {
    if (!Object.hasOwn(START_LABELS, event.label)) return { action: "ignore", reason: "not a factory start label" };
    if (event.isPullRequest) return { action: "ignore", reason: "start labels apply to issues, not PRs" };
    if (!owner) return { action: "ignore", reason: "label applied by a non-owner" };
    return { action: "start", role: START_LABELS[event.label as StartLabel], issue: event.issue };
  }

  if (!event.pullRequest) return { action: "ignore", reason: "comment is not on a PR" };
  if (event.senderType !== "User" || !owner) return { action: "ignore", reason: "comment by a non-owner" };
  const branch = FACTORY_BRANCH.exec(event.pullRequest.headRef);
  if (!branch || !event.pullRequest.headRepoIsBase) return { action: "ignore", reason: "PR is not a factory branch" };
  const body = event.body.trim();
  // Owners opt out of steering with a quote or an explicit marker (PLAN P1-07).
  if (body === "" || body.startsWith(">") || body.toLowerCase().includes("[no-factory]")) {
    return { action: "ignore", reason: "comment opted out of steering" };
  }
  return { action: "resume", role: "builder", issue: Number(branch[1]), pullRequest: event.pullRequest.number, feedback: body };
}
