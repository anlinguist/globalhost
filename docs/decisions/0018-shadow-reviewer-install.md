# ADR-0018: The shadow reviewer gets its own workflow, environment and identities

- Status: accepted
- Date: 2026-11-02
- Relates to: ADR-0014 (Anthropic WIF), ADR-0015 (agent review and merge), ADR-0016/0017 (identities pinned to the default branch's workflow)

## Context

P2-01 adds the reviewer of ADR-0015 in shadow mode: one fresh read-only run per factory PR head, returning function, security and performance verdicts that trusted code validates, archives and posts as a `COMMENT` review. It merges nothing, and its verdicts gate nothing yet. PRs 1–4 built the schemas, control state, role and steps (`globalhost dispatch review-gate|review`). This decision covers how they're installed in a product repo and which credentials they run with.

## Decision

- **A separate installed workflow, `globalhost-review.yml`.** It triggers on `workflow_run` of `globalhost-ci` (completed) and on `pull_request_target: labeled`, so it always runs from the default branch, and no job checks out or runs PR code. The gate job has a read-only `GITHUB_TOKEN` (contents, pull requests, actions) and no environment. Only the review job, `needs: gate`, gets OIDC.
- **Triggers.** A review runs when `globalhost-ci` succeeded for a `pull_request` event on a same-repo `factory/issue-<n>` PR the App opened, at the PR's current head, and the CI run's actor and triggering actor were the App bot or an owner. An owner's `factory:review` label re-reviews the current head. It's the only path that re-reviews a SHA, and the label is removed once acted on.
- **Its own environment, `globalhost-review`, not the dispatcher's `globalhost`.** The review job's timeout is `limits.perRunMinutes`, so a live review is never taken over as stale. A running review is never cancelled, because every exit after its claim must settle its spend.
- **Its own GCP identity, `sa:globalhost-gh-review`.** WIF provider `globalhost-review` accepts only the default branch's `globalhost-review.yml` (`job_workflow_ref` and `workflow_ref`), for those two events, in that environment, on a GitHub-hosted runner. Its grants are on object names. It can read and write each listed repo's `reviews/<repo>/` objects and daily spend records in `globalhost-control`, and only read `state.json`. In `globalhost-runs` it can only create objects, under `<repo>/reviews/`. It can also read `github-app-key`. It can't touch builder locks or other repos' state, and it can't overwrite archives.
- **Its own Anthropic federation rule and Console service account** (ADR-0014), matching environment `globalhost-review`. Revoking reviews doesn't stop builds, and the reverse holds too. Its spend is in the same `globalhost-runners` workspace and under the same caps.
- **Budgets.** `limits.reviewPerRunUsd` (default $2) is reserved before each run. Reviews stop at `limits.reviewPerPrUsd` per PR (default $8) and share the daily `limits.dailyUsd` with builds. A review that's refused for budget is recorded and escalates.

## Consequences

- **Token scoping is self-restraint.** The review environment can read the App's private key, which can mint any permission the App has (contents write included). The review step mints only `REVIEW_PERMISSIONS`: pull requests and issues write, metadata read. That limit is in trusted factory code, pinned by SHA and running no PR code. No credential enforces it. The job's own `GITHUB_TOKEN` and the GCP identity are read-only apart from review state. Follow-up: a separate low-permission GitHub App for reviews, whose key can't push.
- **CI success is PR-controlled.** A factory PR can edit `globalhost-ci.yml`, so a green CI run proves nothing on its own. The harness reads CI as untrusted input. CI is what starts a review; it doesn't make a review pass. Before the reviewer's verdict gates anything (P2-01c), the merge policy must not treat CI success from the PR's own workflow as evidence.
- **Screenshots come only from CI's `smoke` artifact.** It holds PNGs under `screenshots/` (contract in `packages/dispatch/README.md`), and each profile's CI has to upload them that way.
- **Noise.** A PR that's over budget gets an escalation review for each new head SHA, which should be rare at an $8 cap.
- **Cost.** IAM, one WIF provider and one service account are free. Review archives sit in the existing 30-day `globalhost-runs` bucket. Claims and ledgers are small objects in `globalhost-control`; the P1-13 cleanup should delete them once the PR is closed. Agent spend is bounded by the budgets above. On a private repo, a review job uses Actions minutes (up to `perRunMinutes`). No new paid GCP resource.
- **Owner setup per repo:** `reviewRepos` in `infra/factory` and `pulumi up`. Then the `globalhost-review` environment (default branch only), the Console rule and service account, the repo variables, the `factory:review` label, and the workflow file, committed by the owner because the App has no `workflows` permission.
