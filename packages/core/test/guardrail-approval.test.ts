import { describe, expect, it } from "vitest";
import { evaluateApproval, GUARDRAIL_CLASSES, type ApprovalEvidence, type GuardrailClass, type LabelEvent } from "../src/index.js";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const OWNER = { id: 1001, type: "User", login: "owner" };
const LABEL = "approved:deps";
const PUSH = "2026-11-04T10:00:00Z";

const ev = (over: Partial<LabelEvent> = {}): LabelEvent => ({ action: "labeled", label: LABEL, actor: OWNER, at: "2026-11-04T11:00:00Z", headSha: HEAD, ...over });
const evidence = (events: LabelEvent[], over: Partial<ApprovalEvidence> = {}): ApprovalEvidence => ({
  headSha: HEAD,
  lastPushAt: PUSH,
  ownerIds: [1001],
  appActorIds: [9001, 9002],
  currentLabels: [LABEL],
  events,
  ...over,
});
const decide = (events: LabelEvent[], over: Partial<ApprovalEvidence> = {}, subject: { class: GuardrailClass; approvalLabel: string | null } = { class: "guardrail", approvalLabel: LABEL }) =>
  evaluateApproval(subject, evidence(events, over));

describe("evaluateApproval", () => {
  it("clears on an owner's label, after the last push, on the head", () => {
    expect(decide([ev()])).toEqual({ cleared: true, code: "cleared" });
  });

  describe("who applied it", () => {
    it.each([
      ["a bot", { id: 2002, type: "Bot", login: "renovate[bot]" }],
      ["the factory App, even listed as an owner", { id: 9001, type: "Bot", login: "globalhost[bot]" }],
      ["the merge App, even listed as an owner", { id: 9002, type: "Bot", login: "globalhost-merge[bot]" }],
      ["an App ID typed as a user", { id: 9001, type: "User", login: "globalhost" }],
      ["a bot-named user in the owner list", { id: 1001, type: "User", login: "owner[bot]" }],
      ["an owner's ID with a non-user type", { id: 1001, type: "Organization", login: "owner" }],
      ["someone with write access who isn't an owner", { id: 3003, type: "User", login: "collaborator" }],
    ])("refuses %s", (_name, actor) => {
      expect(decide([ev({ actor })], { ownerIds: [1001, 9001, 9002] })).toEqual({ cleared: false, code: "not-owner" });
    });

    it("refuses an unknown (deleted) actor", () => {
      expect(decide([ev({ actor: null })]).code).toBe("not-owner");
    });

    it("matches owners by ID, not login", () => {
      expect(decide([ev({ actor: { id: 3003, type: "User", login: "owner" } })]).code).toBe("not-owner");
    });

    it("does not let an owner's ID as a string through", () => {
      expect(decide([ev({ actor: { id: "1001", type: "User" } as unknown as LabelEvent["actor"] })]).code).toBe("not-owner");
    });
  });

  describe("when it was applied", () => {
    it("refuses a label from before the last push", () => {
      expect(decide([ev({ at: "2026-11-04T09:59:59Z" })])).toEqual({ cleared: false, code: "before-last-push" });
    });

    it("refuses a label in the same second as the push: it could have come first", () => {
      expect(decide([ev({ at: PUSH })]).code).toBe("before-last-push");
    });

    it("a push after approval invalidates it", () => {
      expect(decide([ev()], { lastPushAt: "2026-11-04T12:00:00Z" }).code).toBe("before-last-push");
    });

    it("refuses a label bound to an old SHA, even after the push time", () => {
      expect(decide([ev({ headSha: OLD })])).toEqual({ cleared: false, code: "wrong-sha" });
    });

    it("refuses a label with no recorded SHA", () => {
      expect(decide([ev({ headSha: null })]).code).toBe("wrong-sha");
    });

    it("compares timestamps by instant, not text", () => {
      expect(decide([ev({ at: "2026-11-04T05:00:01-05:00" })]).cleared).toBe(true);
      expect(decide([ev({ at: "2026-11-04T04:59:59-05:00" })]).cleared).toBe(false);
    });
  });

  describe("removal", () => {
    const removed = ev({ action: "unlabeled", at: "2026-11-04T11:30:00Z" });

    it("removing the label invalidates it", () => {
      expect(decide([ev(), removed])).toEqual({ cleared: false, code: "removed" });
    });

    it("anyone's removal counts, a bot's included", () => {
      expect(decide([ev(), { ...removed, actor: { id: 2002, type: "Bot" } }]).code).toBe("removed");
    });

    it("re-applying after removal clears again", () => {
      expect(decide([ev(), removed, ev({ at: "2026-11-04T11:45:00Z" })]).cleared).toBe(true);
    });

    it("a bot re-applying after an owner's approval was removed doesn't restore it", () => {
      expect(decide([ev(), removed, ev({ at: "2026-11-04T11:45:00Z", actor: { id: 2002, type: "Bot" } })]).code).toBe("not-owner");
    });

    it("a label gone from the PR doesn't clear, even if the removal event is missing", () => {
      expect(decide([ev()], { currentLabels: ["approved:visual"] })).toEqual({ cleared: false, code: "label-absent" });
    });

    it("removal under another spelling still counts", () => {
      expect(decide([ev(), { ...removed, label: "Approved:Deps" }]).code).toBe("removed");
    });

    it("in the same second, a removal counts as last", () => {
      expect(decide([{ ...removed, at: "2026-11-04T11:00:00Z" }, ev()]).code).toBe("removed");
    });
  });

  describe("odd event streams", () => {
    it("handles out-of-order events", () => {
      const removed = ev({ action: "unlabeled", at: "2026-11-04T11:30:00Z" });
      const again = ev({ at: "2026-11-04T11:45:00Z" });
      expect(decide([again, removed, ev()]).cleared).toBe(true);
      expect(decide([removed, ev()]).code).toBe("removed");
    });

    it("duplicates change nothing", () => {
      expect(decide([ev(), ev(), ev()]).cleared).toBe(true);
    });

    it("a qualifying and a non-qualifying label in the same second clear in either order", () => {
      const bot = ev({ actor: { id: 2002, type: "Bot" } });
      expect(decide([bot, ev()]).cleared).toBe(true);
      expect(decide([ev(), bot]).cleared).toBe(true);
    });

    it("no events: the label's presence alone isn't approval", () => {
      expect(decide([])).toEqual({ cleared: false, code: "no-event" });
    });

    it.each(["yesterday", "", "2026-11-04", "Nov 4 2026 11:00", "2026-13-99T00:00:00Z"])("an unreadable timestamp voids it: %j", (at) => {
      expect(decide([ev(), ev({ action: "unlabeled", at })]).code).toBe("invalid-evidence");
    });

    it("an unknown action voids it", () => {
      expect(decide([ev(), ev({ action: "renamed" as unknown as "labeled" })]).code).toBe("invalid-evidence");
    });

    it("ignores other labels' events, including a malformed one", () => {
      expect(decide([ev(), ev({ label: "approved:visual", action: "unlabeled", at: "nonsense" })]).cleared).toBe(true);
    });

    it("refuses an unreadable last push", () => {
      expect(decide([ev()], { lastPushAt: "unknown" }).code).toBe("invalid-evidence");
    });

    it("refuses a head that isn't a full SHA, even when the event matches it", () => {
      expect(decide([ev({ headSha: "abc123" })], { headSha: "abc123" }).code).toBe("invalid-evidence");
    });

    it("another spelling of the label isn't this label", () => {
      expect(decide([ev({ label: "Approved:Deps" })], { currentLabels: [LABEL] }).code).toBe("label-absent");
    });
  });

  describe("what it can clear", () => {
    it("a label clears only its own guardrail", () => {
      const visual = { class: "guardrail" as const, approvalLabel: "approved:visual" };
      expect(decide([ev()], { currentLabels: [LABEL] }, visual).cleared).toBe(false);
      expect(decide([ev()], { currentLabels: [LABEL, "approved:visual"] }, visual).code).toBe("no-event");
    });

    it.each(["integrity", "instruction-surface", "prod-credential", "release-set", "immutable", "provenance", "taint"] as const)("never clears %s", (cls) => {
      const label = `approved:${cls}`;
      const events = [ev({ label })];
      expect(decide(events, { currentLabels: [label] }, { class: cls, approvalLabel: label })).toEqual({ cleared: false, code: "not-clearable" });
    });

    it("every class is either clearable (and tested above) or refused", () => {
      const clearable = GUARDRAIL_CLASSES.filter((cls) => decide([ev()], {}, { class: cls, approvalLabel: LABEL }).cleared);
      expect(clearable).toEqual(["load-bearing", "guardrail"]);
    });

    it.each([null, "deps", "approved:", "approved:Deps", "factory:ship", "approved:a b"])("refuses a guardrail with the label %j", (approvalLabel) => {
      const label = approvalLabel ?? LABEL;
      expect(decide([ev({ label })], { currentLabels: [label] }, { class: "guardrail", approvalLabel }).code).toBe("not-clearable");
    });
  });
});
