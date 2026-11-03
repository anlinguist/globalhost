// The installed review workflow (templates/.github/workflows/globalhost-review.yml) against the contracts of the
// review steps. actionlint and zizmor check the file's syntax and the usual Actions hazards in `pnpm lint`; this
// checks what they can't: that the template and packages/dispatch agree.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CI_WORKFLOW_NAME, REVIEW_LABEL } from "../src/index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = readFileSync(`${root}templates/.github/workflows/globalhost-review.yml`, "utf8");
const action = readFileSync(`${root}packages/action/action.yml`, "utf8");

/** The text of one top-level job, from its key to the next job (or the end). */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no job ${name}`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
/** A job's `permissions:` block as `scope: level` lines, comments dropped. */
function permissions(text: string): string[] {
  const m = /\n {4}permissions:\n((?: {6}.*\n)+)/.exec(text);
  if (!m) throw new Error("no permissions block");
  return m[1]!
    .split("\n")
    .filter(Boolean)
    .map((l) => l.replace(/#.*$/, "").trim());
}

describe("globalhost-review.yml template", () => {
  it("triggers on globalhost-ci completing and on labels, with no workflow-level permissions", () => {
    expect(workflow).toContain(`workflows: [${CI_WORKFLOW_NAME}]`);
    expect(workflow).toMatch(/workflow_run:.*\n {4}workflows: \[globalhost-ci\]\n {4}types: \[completed\]/);
    expect(workflow).toMatch(/pull_request_target:.*\n {4}types: \[labeled\]/);
    expect(workflow).toContain(`github.event.label.name == '${REVIEW_LABEL}'`);
    expect(workflow).toMatch(/\npermissions: \{\}\n/);
  });

  it("never interpolates event data into a shell step or checks out code", () => {
    const runLines = workflow.split("\n").filter((l) => /^\s+(-\s+)?run:/.test(l));
    expect(runLines.length).toBeGreaterThan(0);
    for (const l of runLines) expect(l).not.toContain("${{");
    expect(workflow).not.toMatch(/actions\/checkout/);
    expect(workflow).not.toContain("GITHUB_ENV");
  });

  it("gives the gate a read-only token and no environment or OIDC", () => {
    const gate = job("gate");
    expect(permissions(gate)).toEqual(["contents: read", "pull-requests: read", "actions: read"]);
    expect(gate).not.toContain("environment:");
    expect(gate).toContain("step: review-gate");
    for (const out of ["action", "pr", "timeout"]) expect(gate).toContain(`${out}: \${{ steps.gate.outputs.${out} }}`);
  });

  it("runs the review job in globalhost-review, read-only plus OIDC, never cancelled, timed from the gate", () => {
    const review = job("review");
    expect(review).toContain("needs: gate");
    expect(review).toContain("if: needs.gate.outputs.action == 'review' || needs.gate.outputs.action == 'unlabel'");
    expect(review).toContain("environment: globalhost-review");
    expect(permissions(review)).toEqual(["contents: read", "issues: read", "pull-requests: read", "actions: read", "id-token: write"]);
    expect(review).toContain("timeout-minutes: ${{ fromJSON(needs.gate.outputs.timeout) }}");
    expect(review).toContain("GLOBALHOST_JOB_TIMEOUT_MINUTES: ${{ needs.gate.outputs.timeout }}");
    expect(review).toMatch(/concurrency:\n\s+group: globalhost-review-pr-\$\{\{ needs\.gate\.outputs\.pr \}\}\n\s+cancel-in-progress: false/);
    expect(review).toContain("step: review");
  });

  it("records the job's start in its first step and passes it to the review step", () => {
    const steps = job("review").split("\n    steps:\n")[1]!;
    const first = steps.split(/^ {6}- /m)[1]!;
    expect(first).toContain("id: started");
    expect(first).toContain('run: echo "at=$(date +%s)" >> "$GITHUB_OUTPUT"');
    expect(steps).toContain("GLOBALHOST_JOB_STARTED_AT: ${{ steps.started.outputs.at }}");
  });

  it("uses the review's own GCP identity and Anthropic federation rule, never the dispatcher's", () => {
    const review = job("review");
    expect(review).toContain("workload_identity_provider: ${{ vars.GLOBALHOST_REVIEW_WIF_PROVIDER }}");
    expect(review).toContain("service_account: ${{ vars.GLOBALHOST_REVIEW_SA }}");
    expect(review).toContain("ANTHROPIC_FEDERATION_RULE_ID: ${{ vars.ANTHROPIC_REVIEW_FEDERATION_RULE_ID }}");
    expect(review).toContain("ANTHROPIC_SERVICE_ACCOUNT_ID: ${{ vars.ANTHROPIC_REVIEW_SERVICE_ACCOUNT_ID }}");
    expect(workflow).not.toContain("GLOBALHOST_DISPATCH_SA");
    expect(workflow).not.toContain("vars.ANTHROPIC_FEDERATION_RULE_ID");
    expect(workflow).not.toContain("secrets.");
  });

  it("pins every action by commit SHA, the factory action by the install placeholder", () => {
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBe(3);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
    expect(uses.filter((u) => u.startsWith("anlinguist/globalhost/packages/action@"))).toHaveLength(2);
  });

  it("matches the composite action's steps and outputs", () => {
    expect(action).toMatch(/step:\n\s+description: gate \| run \| observe \| review-gate \| review/);
    expect(action).toMatch(/\n {2}timeout:\n.*\n {4}value: \$\{\{ steps\.dispatch\.outputs\.timeout \}\}/);
  });
});
