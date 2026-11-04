// `approved:*` semantics (ADR-0015 §10), as a pure function over label events the caller supplies. A label clears
// only its own guardrail, only when an owner ID applied it after the PR's last push and on the current head, and
// never clears a class outside CLEARABLE_CLASSES. Anything ambiguous is "not cleared".
import { isOwnerActor } from "./trust-gate.js";

/** Every kind of thing that can escalate. Only the clearable ones can be acknowledged with a label. */
export const GUARDRAIL_CLASSES = [
  "integrity",
  "instruction-surface",
  "prod-credential",
  "release-set",
  "immutable",
  "provenance",
  "taint",
  "load-bearing",
  "guardrail",
] as const;
export type GuardrailClass = (typeof GUARDRAIL_CLASSES)[number];

/** An allowlist, so a class added later can't be cleared until someone says it can. Everything else needs the owner's ship. */
export const CLEARABLE_CLASSES: readonly GuardrailClass[] = Object.freeze(["load-bearing", "guardrail"]);

export const APPROVAL_LABEL_PATTERN = /^approved:[a-z0-9][a-z0-9-]{0,63}$/;

/** What the caller knows about who acted. A deleted account has no actor. */
export interface LabelActor {
  id: number;
  /** GitHub's account type: "User", "Bot", "Organization"… Only "User" can be an owner. */
  type: string;
  login?: string;
}

export interface LabelEvent {
  action: "labeled" | "unlabeled";
  label: string;
  actor: LabelActor | null;
  /** ISO-8601, as GitHub's server recorded it. */
  at: string;
  /** The PR's head when the event happened; null when the caller can't say, which never clears. */
  headSha: string | null;
}

export interface ApprovalEvidence {
  /** The head the guardrails ran on (40 hex). */
  headSha: string;
  /** When that head was pushed, from a server-side record. Commit dates are chosen by whoever commits, so never those. */
  lastPushAt: string;
  /** From factory.yaml on the base branch, never the PR's head. */
  ownerIds: readonly number[];
  /** Both Apps' bot user IDs: never an owner, even if listed in `ownerIds` (ADR-0015 §10). */
  appActorIds: readonly number[];
  /** The PR's labels now: a cross-check, since an event list can be cut short by paging. */
  currentLabels: readonly string[];
  events: readonly LabelEvent[];
}

export const APPROVAL_CODES = [
  "cleared",
  "not-clearable",
  "invalid-evidence",
  "label-absent",
  "no-event",
  "removed",
  "not-owner",
  "before-last-push",
  "wrong-sha",
] as const;
export type ApprovalCode = (typeof APPROVAL_CODES)[number];

export interface ApprovalDecision {
  cleared: boolean;
  /** Why, from a closed set, so it is safe to post. */
  code: ApprovalCode;
}

const SHA40 = /^[0-9a-f]{40}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Milliseconds, or null for anything but a full ISO-8601 timestamp. */
function parseTime(at: unknown): number | null {
  if (typeof at !== "string" || !ISO_TIME.test(at)) return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

function whyNotQualifying(e: LabelEvent, label: string, at: number, pushedAt: number, ev: ApprovalEvidence): ApprovalCode | null {
  // GitHub keeps one spelling per repo, so another spelling isn't this label, whoever applied it.
  if (e.label !== label) return "label-absent";
  if (!e.actor || !isOwnerActor(e.actor, ev.ownerIds) || ev.appActorIds.includes(e.actor.id) || e.actor.login?.endsWith("[bot]")) return "not-owner";
  // GitHub's timestamps have one-second resolution: a label in the same second as the push may have come first.
  if (at <= pushedAt) return "before-last-push";
  if (e.headSha !== ev.headSha) return "wrong-sha";
  return null;
}

/** Does `subject`'s own label clear it on this head? */
export function evaluateApproval(subject: { class: GuardrailClass; approvalLabel: string | null }, ev: ApprovalEvidence): ApprovalDecision {
  const no = (code: ApprovalCode): ApprovalDecision => ({ cleared: false, code });
  const label = subject.approvalLabel;
  if (!CLEARABLE_CLASSES.includes(subject.class) || label === null || !APPROVAL_LABEL_PATTERN.test(label)) return no("not-clearable");

  const pushedAt = parseTime(ev.lastPushAt);
  if (pushedAt === null || !SHA40.test(ev.headSha)) return no("invalid-evidence");

  const relevant: Array<{ e: LabelEvent; at: number }> = [];
  for (const e of ev.events) {
    if (typeof e?.label !== "string" || e.label.toLowerCase() !== label) continue;
    const at = parseTime(e.at);
    // An event we can't place or read could be the removal, so it voids the approval.
    if (at === null || (e.action !== "labeled" && e.action !== "unlabeled")) return no("invalid-evidence");
    relevant.push({ e, at });
  }
  if (!ev.currentLabels.includes(label)) return no("label-absent");

  // Oldest first; in the same second a removal counts as last. Within a tie the labels' order can't change the outcome.
  relevant.sort((a, b) => a.at - b.at || Number(a.e.action === "unlabeled") - Number(b.e.action === "unlabeled"));
  let state: ApprovalCode = "no-event";
  for (const { e, at } of relevant) {
    if (e.action === "unlabeled") {
      state = "removed"; // Anyone's removal voids it: leaving it in place would be the fail-open direction.
      continue;
    }
    if (state === "cleared") continue; // Re-applying can't undo an approval; only a removal or a push can.
    state = whyNotQualifying(e, label, at, pushedAt, ev) ?? "cleared";
  }
  return { cleared: state === "cleared", code: state };
}
