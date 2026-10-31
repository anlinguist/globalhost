# ADR-0015: Agents review and merge; the owner handles exceptions

- Status: accepted
- Date: 2026-10-30
- Amends: ADR-0006 (who merges), ADR-0009 (what reviewers read), ADR-0010 (the kernel's owner merge gate), ADR-0013 (`autoMerge`)

## Context

The plan so far made the owner the permanent final reviewer:
- the taste gate (SDLC ◆B) before every merge, at every level;
- agent merges only at L3, and only for an allowlist of trivial classes (`autoMerge`);
- one reviewer role (P2-01) checking a PR against its spec.

The owner's direction (2026-10-30): agents will write more code than one person can review, so line-by-line review by the owner isn't the safety mechanism. The owner's effort goes into the review architecture (skills, rubrics, evals) that decides what matters: functionality, performance and cost, and security. The owner can review anything at any time but shouldn't have to.

Removing the owner from the merge path removes a check that several existing guarantees silently relied on. The rules below put that check back as code and capability limits, not prompts. This ADR fixes the design. Exact values (timeouts, patterns, thresholds, budgets) are set by the implementing items, with tests.

## Decision

### Scope

1. **The end state is agent merge with owner escalation.** At L3, owner-originated work that passes review merges without the owner. The owner is pulled in only by an escalation trigger (8), and can look at anything at any time.
   - **Visibility:** until G.Host (Phase 3), every agent merge is visible on GitHub, and GitHub's revert button is the undo path.
   - **Where L3 is possible:** only on repos whose ruleset enforces the merge-policy check (public repos, or private ones after the ADR-0006 upgrade).
   - **The factory repo** never goes above L2, so the factory can't change its own kernel, reviewers or evals without the owner.

### Review

2. **One reviewer run, three verdicts.** The reviewer is a fresh run on the PR's head, read-only, and never the builder (ARCHITECTURE principle 3). It returns three verdicts: **function** (meets the spec and plan), **security** (trust boundaries, injection, secrets, authn/authz, supply chain) and **performance/cost**. The run is split into separate specialist runs only if the evals (11) show that catches more.
   - **What the reviewer reads:** the diff, the spec and plan, CI results, and CI-captured artifacts (screenshots, Playwright traces). It doesn't read the live preview, so reviewers need no preview credentials. It doesn't read the builder's session or summary either; those are kept for audit only (amends ADR-0009).
   - **Which PRs get reviewed:** only App-authored, same-repo PRs from `factory/*` branches.

3. **Verdicts come from the harness, not from the agent's word.**
   - The harness takes the verdict only from the session's structured output, validates it against a schema, and stamps it with the run ID and the SHA it checked out. The reviewer's own claim of which SHA it reviewed doesn't count.
   - Verdicts are archived in GCS and read only from there. Never from PR comments, and never from files in the checkout.
   - The publisher refuses any bundle that contains `REVIEW.json` or `run.json`.
   - Findings use a closed category list, which is what the triggers in (8) key on.

4. **A verifier can downgrade findings but never clear a security one.**
   - A separate verifier run checks `changes` findings. It can downgrade `function` and `performance` findings, and escalate anything.
   - An `escalate` verdict is final, and the verifier never sees it.
   - If the verifier rejects a `security` finding, the PR escalates.

5. **Prompt injection against reviewers is assumed.** The diff and the CI artifacts come from builder-written code. So:
   - the reviewer treats them as data;
   - self-reported confidence never feeds the merge decision;
   - a deterministic scan escalates diffs that contain text addressed to reviewers or verdict-shaped content. Its pattern list lives in core, with fixtures.

   This is defence in depth. Provenance (7), the triggers (8) and the release split (9) carry the weight.

### Merge

6. **The merge decision is deterministic code, bound to the reviewed commit.**
   - **Inputs:** CI, guardrail results, the verified verdicts, triggers, provenance and taint, the effective level (12) and the budget.
   - **Outputs:** merge, send back to the builder (at most two fix rounds), or escalate.
   - **Fail closed:** a missing, timed-out or invalid verdict escalates.
   - **The commit it merges is the one that was reviewed:**
     - the verdict's stamped SHA is the head that was reviewed;
     - if the ship action rebases, the rebased diff must have the same `git patch-id --stable` and CI must be green on the new head; otherwise the review runs again;
     - triggers are recomputed on the final diff;
     - the merge call is pinned to the final SHA;
     - the PR is same-repo, App-authored, and from a `factory/*` branch.
   - **Recording:** the decision (including shadow decisions at L2) goes to the run record in GCS and to the `globalhost/merge-policy` check.

7. **Provenance and taint.**
   - **Owner-originated:** every authored text in the chain has an owner author ID: the issue body, steering comments, and the approved plan.
   - **Plan approval:** an owner's `factory:build` applied after a plan comment approves that comment. The dispatcher records the comment's ID and a hash of its text, and a later edit invalidates the approval. Who applied a label doesn't otherwise count, so an owner-labelled issue from someone else is not owner-originated. G.Host drafts are approved the same way (by hash, as an owner action).
   - **Untrusted input** is anything authored by a non-owner or an outside system: others' issues and comments, Sentry, scanners, web pages, vendor MCP responses, Renovate and upstream changelogs.
   - **Outsiders' comments are dropped.** The harness never passes non-owner comments on a factory PR or issue to agents, so a stranger can't taint a PR just by commenting.
   - **Taint is a property of what a run could see, and it's set by the harness.** A run is tainted if its prompt contained fenced untrusted input, or if it had tools or egress that reach third-party-authored content (web fetch, vendor MCP, GitHub reads, open package registries).
     - To keep ordinary runs untainted, the harness checks out and installs from the lockfile before the agent starts. L3-eligible runs then get no package or GitHub egress (or only a proxy serving lockfile-pinned packages).
     - Taint carries forward: from planner to builder, from a draft to its approval, and across rounds.
   - **Factory-derived input doesn't taint**, as long as it arrives as schema-validated structured fields and never as free text:
     - CI results: check name, conclusion, test ID, file:line, assertion;
     - review findings: file, line, category, code.

     Any free-text CI log excerpt passed to an agent is fenced as untrusted (CLAUDE.md #4) and taints the run.

     An adversarial fixture covers this.
   - **Effect:** work that isn't owner-originated, or a tainted run, always escalates.

8. **Escalation triggers.** Every trigger is a path glob, a guardrail ID or a finding category, and the globs are kept as a constant in core with fixtures. A product's `factory.yaml` can add `loadBearing` globs but can't remove a trigger.
   - **Instruction surfaces:** `**/CLAUDE.md`, `**/CLAUDE.local.md`, `**/AGENTS.md`, `**/.claude/**`, `.mcp.json`, `docs/product/**`, `skills/**`. Builders don't edit product memory in feature PRs. Memory updates come through their own owner-reviewed PRs.
   - **Paths that run with prod credentials:** `factory.yaml`, `.github/**`, and the deploy adapter's release execution set (9).
   - **`loadBearing` globs.** Before L3, onboarding must list the auth, payment and security-rules files there.
   - **Guardrails** (P2-03): any dependency change (new, bumped, or re-resolved in the lockfile, transitive entries included), destructive or contract migration, breaking API, extension permissions.
   - **From review:**
     - a security finding in the auth, IAM, secrets or supply-chain categories;
     - the verifier rejecting a security finding;
     - a missing or invalid verdict;
     - text addressed to reviewers in the diff.
   - **From the run:**
     - a provenance or taint failure;
     - the review budget exceeded;
     - a third fix round.

9. **Release safety: build without prod credentials, and be able to roll back.** A part can be agent-merged only if its deploy adapter declares all three:
   - **a build/deploy split:** the build runs with no prod or deploy credentials, and a separate deploy step consumes only the built artifact. The **release execution set** is that deploy step's inputs (deploy configs, scripts, IaC).
   - **staged rollout with synthetic health checks;**
   - **automatic rollback.**

   `globalhost validate` refuses L3 when any prod part's adapter doesn't declare all three. numu-know's current deploy has neither the split nor rollback, so it needs P2-01d first.

   Rollback can't undo data writes, sent email, payments or leaked data. Migrations and the release execution set escalate for that reason. Runtime code that has side effects is the accepted residual risk.

10. **A separate merge identity.**
    - **The merge App:** a second GitHub App, `globalhost-merge`, holds `checks: write` and merge rights.
    - **Its key** is readable only by a merge service account. That account is bound by WIF to a dedicated merge workflow on the default branch, in a `globalhost-merge` environment.
    - **The ruleset** requires the `globalhost/merge-policy` check *from that App*. So the main App, CI jobs and anything running agent-written code can't produce a passing check, and the main App can't merge a factory PR.
    - **The ruleset requires the check on every repo it protects, at every level.** Below L3, and for escalated PRs, the policy passes only on the owner's ship: a `factory:ship` label applied by an owner ID after the PR's last push, bound to that head SHA. The merge App then carries out the merge, so the owner's label tap or G.Host tap works and needs no extra merge path. The owner can also merge directly, as the ruleset's only bypass actor.
    - `approved:*` labels clear only their own guardrail, tied to the head SHA. They never clear instruction-surface, release-set, provenance or taint triggers (only the owner's ship does).
    - **The merge workflow runs no product-repo code.** It's a factory action pinned by SHA, and its inputs are treated like the release execution set.
    - **Neither App's identity** ever counts as an owner.

### Trust over time

11. **Reviewers earn trust through evals.**
    - **The corpus:** seeded defects (functional bugs, vulnerabilities, performance regressions, reviewer-manipulation attempts) in frozen repo snapshots.
    - **What it measures:** the reviewer's catch rate and false-positive rate, and the verifier's false-downgrade rate.
    - **Gating:** the eval suite is a required check on any factory-repo PR that changes a reviewer prompt, skill or pinned model ID. Reviewer models are pinned by ID, never by alias.
    - **Incidents:** every incident caused by an agent merge adds a case.

12. **Autonomy ladder.**
    - **The levels** (ONBOARDING §2):
      - **L0 observe;**
      - **L1 on request:** the owner merges;
      - **L2 shadow:** the review and policy run on every factory PR and record what they would have done, while the owner still merges;
      - **L3 agent merge.**
    - **Promotion to L3 needs all of these:**
      - 20 PRs where the policy said *merge* and the owner merged that same SHA unchanged;
      - every miss tagged by the owner with a closed `miss:*` label, and no `miss:security`;
      - the eval thresholds met;
      - (1) and (9) satisfied.
    - **Demotion:** trusted code opens a `factory:demoted` issue (App-authored) on an incident (a rollback, or a revert of an agent merge). While it's open, the effective level is L2. Only the owner closing it restores the level. The issue is the flag; there is no second copy.

13. **Cost.**
    - **Worst case per PR:** at most three review rounds (the first plus two fix rounds), each one reviewer run plus at most one verifier run. That's about six review-side runs under the per-run caps of ADR-0004.
    - **Default per-PR review budget:** $8. Going over it escalates.
    - **Evals** are budgeted separately inside the runners workspace and run only on reviewer changes.
    - **Tracking:** review cost per merged PR is in the metrics, and P2-05 sets the actual numbers.

## Consequences

- **`factory.yaml`:**
  - No new key: extra escalation paths go in `loadBearing`.
  - `autoMerge` stays valid for schema compatibility, but it can't take effect: L3 needs the merge policy, so before the policy it's unreachable, and after it the policy decides. Removing it is a later version bump (FACTORY-YAML §8).
  - The rule "L3 needs adapters that declare split + staged + rollback" gets an error code in P2-01c.
- **Renovate PRs always escalate.** A narrow deterministic exception needs its own ADR.
- **P2-01 (review)** changes the dispatcher's trust gate (ARCHITECTURE §2.3), so App events on App-authored `factory/*` PRs can start a review. It also moves builder setup (checkout, lockfile install) before the agent starts and narrows builder egress (ARCHITECTURE §4 rule 4).
- **P2-04 (ship)** builds on the merge App, so the App and its ruleset arrive with the ship action rather than later.
- **P2-01c (merge policy)** amends:
  - CLAUDE.md non-negotiables #3 and #6, naming the merge workflow as the only other writer to the default branch, and only by merging a policy-approved PR at a pinned SHA;
  - the ARCHITECTURE permission table (the merge App and the merge service account);
  - the publisher's "The owner merges" PR text.
- **SDLC changes:** ◆B (taste gate) is optional at L3; the review stage feeds the merge policy; previews still exist for the owner, but the reviewer judges from CI artifacts.
- **PLAN Phase 2 is reordered:** guardrails, ship action and budgets first, then review, reviewer evals, the merge policy, and the numu-know release split and canary. Phase 1 is unchanged: L1, and the owner merges.
- **The risk the owner accepts:** a wrong agent merge whose effects are reversible is caught by rollback, monitoring and revert, not before merge.
