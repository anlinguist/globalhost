# ADR-0015: Agents review and merge; the owner handles exceptions

- Status: accepted
- Date: 2026-10-30

## Context

The plan so far made the owner the permanent final reviewer:
- the taste gate (SDLC ◆B) before every merge, at every level;
- agent merges only at L3, and only for an allowlist of trivial classes (`autoMerge`, e.g. Renovate patches);
- one reviewer role (P2-01) checking a PR against its spec.

The owner's direction (2026-10-30): agents will write more code than one person can review, so line-by-line review by the owner isn't the safety mechanism. The owner's effort goes into the review architecture (skills, rubrics, evals) that decides what matters: functionality, performance and cost, and security. The owner can review anything at any time but shouldn't have to, and the whole loop should be manageable from G.Host.

## Decision

1. **The end state is agent merge with owner escalation.** At the top autonomy level, owner-originated work that passes review merges without the owner. The owner is pulled in only by the escalation triggers in (5). Everything merged is visible in G.Host, with its verdicts, and one tap opens a revert PR.

2. **Review is a panel of independent specialists.** Each reviewer is a fresh run on the exact head SHA with read-only credentials, and none of them is the builder (ARCHITECTURE principle 3 stands). The first panel:
   - **function**: the PR meets the spec and plan, judged from tests, the preview and screenshots, not the builder's summary;
   - **security**: trust boundaries, injection, secrets, authn/authz, supply chain;
   - **performance and cost**: regressions, unbounded work, query and bundle size, cloud spend.

   Each reviewer writes a structured verdict (pass / changes / escalate, findings with evidence, confidence). A finding that would block or escalate is checked by a separate verifier run before it counts, so false positives don't stall the loop. Reviewers run only where a PR's paths make them relevant (a docs-only PR skips performance), and the panel can use a different model or skill set from the builder. The diff and the builder's notes are data to reviewers, never instructions.

3. **The merge decision is deterministic code.** A merge-policy step in trusted code (not an LLM) reads CI, guardrails, the verified verdicts, the PR's risk class, its provenance, the repo's autonomy level and the budget. It returns one of: merge, send back to the builder (at most two rounds), or escalate (`needs:owner-approval`). It merges through the serialized ship action (P2-04), so merging is still the only path to prod (principle 2).

4. **Provenance limits what can merge without the owner.** Only work whose intent came from an owner (an owner-filed or owner-labelled issue, or an owner-approved plan in G.Host) can merge without the owner. Work triggered or shaped by untrusted input always escalates: Sentry auto-fixes, scanner findings, issues from others, and content fetched from the web. This keeps a prompt injection from reaching prod with no human in the path.

5. **Escalation triggers, at every level:**
   - `loadBearing` paths, auth and payment code;
   - `factory.yaml`, `.github/**`, IAM, infrastructure that touches prod;
   - destructive or contract migrations, breaking API changes, extension permissions;
   - new dependencies (until a supply-chain reviewer exists);
   - reviewer disagreement, low confidence, or a finding the verifier upheld;
   - budget overruns, and a third builder round.

   A product's `factory.yaml` can add triggers but can't remove these.

6. **Agent merge needs safe releases.** A part can't be agent-merged unless its deploy adapter does a staged rollout with health checks and automatic rollback (or the part has no prod surface). numu-know's `cloud-build-trigger` deploys straight to prod today, so it needs the canary path first.

7. **Reviewers earn trust by evals, not by being read.** A seeded-defect corpus (functional bugs, vulnerabilities, performance regressions planted in frozen repo snapshots) measures each reviewer's catch rate and false-positive rate. It reruns on every change to a reviewer's prompt, skill or model. A drop below the threshold demotes every repo that relies on that reviewer. Every incident caused by an agent merge adds a case to the corpus.

8. **The autonomy ladder** (ONBOARDING §2) becomes:
   - **L0 observe**;
   - **L1 on request**: the owner merges;
   - **L2 panel in shadow**: the panel runs on every PR and the merge policy records what it *would* have done, while the owner still merges. That track record calibrates the panel against the owner's decisions.
   - **L3 agent merge**: the merge policy merges owner-originated work, subject to (4)–(6).

   Promotion to L3 needs the shadow record, the reviewer eval thresholds, and safe releases for every prod part. Demotion is immediate on an incident.

## Consequences

- The `factory.yaml` `autoMerge` category list is superseded by (8) and an `escalate` list for extra triggers. The schema change lands with the merge-policy work (additive, version stays 1). ADR-0013's rule that `autoMerge` needs L3 carries over.
- The App needs permission to merge, used only by the merge-policy step on the default branch's workflow. The ARCHITECTURE permission table changes in that PR. The App's identity still never counts as an owner.
- SDLC ◆B (taste gate) is optional at L3: the owner looks when they want to, or when escalated.
- Cost: each PR adds up to three reviewer runs plus verifier runs. They come out of the same per-run and daily budgets, and the metrics track it per merged PR.
- PLAN changes: Phase 2 now builds the panel, the merge policy, reviewer evals (pulled from Phase 6) and the canary adapter (pulled from Phase 4). Phase 1 is unchanged: L1, owner merges.
- A wrong agent merge is caught by rollback, monitoring and revert, not before merge. The owner accepts that trade for throughput.
