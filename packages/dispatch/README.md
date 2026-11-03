# @globalhost/dispatch

The dispatcher and publisher (PLAN P1-07, ARCHITECTURE §2.3). It's the logic behind the workflow installed in product repos, `templates/.github/workflows/globalhost.yml`. That workflow runs it through the composite action `packages/action`, pinned by commit SHA.

## Flow

```
issues.labeled / issue_comment
  └─ gate      (read-only GITHUB_TOKEN, no environment)
       factory.yaml from the default branch → trust gate (owner IDs) → start | resume | ignore
  └─ dispatch  (environment `globalhost`; id-token: write)
       WIF → GCP as sa:globalhost-gh-dispatch
       kill switch, daily budget, branch claim, builder slot      (gs://globalhost-control)
       each part's profile detects on a REST snapshot of the default branch
         → guidance + network environment for the run
       Managed Agents session via the GitHub OIDC → Anthropic rule (ADR-0014)
       archive outputs                                            (gs://globalhost-runs)
       App installation token (key from Secret Manager, minted per write)
       publisher: re-verify bundle → path policy → push factory/issue-<n> (never forced)
                  → draft PR → run report + labels
```

**Run and publish share one job.** The agent never executes in the Actions job: it runs in the Managed Agents sandbox and returns a git bundle. The job only fetches that bundle into a bare repo, with no checkout and no hooks. Splitting the job would add an artifact hop without separating any untrusted code.

**What triggers what:**

| Trigger | Result |
|---|---|
| An owner applies `factory:plan` | Planner run. The plan is posted as an issue comment, and the issue is labeled `factory:planned`. |
| An owner applies `factory:build` | Builder run, which starts from the latest plan if there is one. It pushes `factory/issue-<n>`, opens a draft PR, and labels the issue `factory:in-review`. |
| An owner comments on a `factory/*` PR | The builder's session resumes with the comment as feedback, plus a budget top-up of `limits.perRunUsd`. A comment starting with `>`, or containing `[no-factory]`, is ignored. |
| An owner replies on an issue labeled `factory:planned` or `factory:blocked` | The planner's session resumes with the reply as feedback (same budget top-up) and posts a revised plan. Same opt-outs as PR steering. |
| Anything by a non-owner | Nothing. No run and no comment. |

The session ID travels in a hidden marker on the bot's run-report comment. Only markers on comments by the App's bot user are trusted, and agent text has `<!--` neutralized before it's posted.

**After a merge** (P1-12), `templates/.github/workflows/globalhost-release.yml` runs `globalhost dispatch observe` on the default branch. It waits for each `cloud-build-trigger` part's prod build for the merge commit, comments the result on the merged PR and on a factory PR's issue (build id, state and console link only), and closes the issue once every build succeeded, but only for PRs the App opened (needs `GLOBALHOST_APP_SLUG`; a factory branch whose PR was opened by hand doesn't auto-close). A failed or cancelled build, no build found, or a 401/403/404 from Cloud Build leaves the issue open and fails the job; a build still running at the deadline is reported and leaves the job green. Only the pushed head commit's PR is reported when one push lands several merges. Factory PRs reference their issue with `Refs #<n>`, and the publisher rewrites closing keywords in agent commit messages and the PR title to `refs`, so merging alone doesn't close it. Polling costs Actions minutes for up to the timeout on every push to the default branch (free on public repos; counts against the private-repo quota). Settings: `OBSERVE_TIMEOUT_MINUTES` (default 30, max 60), `OBSERVE_POLL_SECONDS` (default 20).

**Failures** of the dispatcher itself (sign-in, API or harness errors) are reported on the issue or PR with a link to the Actions run, and the issue is labeled `factory:failed`; the error text stays in the run log.

**Refusals** are posted as a comment, and nothing runs. They happen when:
- the factory is paused;
- today's per-repo spend plus `perRunUsd` would exceed `dailyUsd`;
- `factory/issue-<n>` already exists, which is the branch claim: steer the existing PR instead;
- all `maxConcurrentBuilders` slots are busy.

## Review control state (P2-01, not wired to a workflow yet)

`ControlPlane` also holds the reviewer's state in `gs://globalhost-control/reviews/<owner>/<name>/` (repo lowercased; repo, PR number, SHA and run ID are validated before they go into an object name; the SHA must be 40-hex, so a SHA-256 repository fails closed):

- **`pr-<n>/<sha>.claim.json`:** one live review attempt per head SHA. `reviewClaim(head, runId, { perRunMinutes, rereview })` creates it (create-only). An uncompleted claim older than `minReviewStaleMinutes(perRunMinutes)` (= `perRunMinutes` + 30) is a crashed run and is taken over by compare-and-swap. A completed claim is replaced only with `rereview` (an owner's `factory:review`), as the next `attempt`; a re-review never displaces an in-flight one. A corrupt claim is never taken over (`reason: "corrupt"`).
- **`pr-<n>.json`:** the PR's review ledger and shadow index (`ReviewLedgerSchema` in core): settled spend, open reservations, and one `ShadowEntry` per run (runs past 200 drop off, their cost kept in `truncatedSpendUsd`). A corrupt ledger counts as over budget and is never overwritten.
- **Daily spend:** reviews share `spend/<day>/<repo>.json` with builders. Open review reservations sit there too, and `spentTodayUsd` counts them.

**Contract for the review step** (also at the top of the review section in `src/gcp.ts`):

1. `reserveReview(head, runId, { perRun, perPr, dailyUsd })` before anything runs. It holds `reviewPerRunUsd` on the PR ledger and then on the day's spend record. If either is refused, don't run; the PR escalates.
2. `reviewClaim`. If it isn't claimed, don't run.
3. Archive under `reviewArchivePrefix(head, runId)` in `globalhost-runs` (`<repo>/reviews/pr-<n>/<sha>/<runId>/`), per attempt.
4. `completeReviewClaim(head, runId)`. Post the GitHub review only if it returned true.
5. `recordReviewRun` **always**, with the actual cost (0 if nothing ran). It settles the reservation on the reservation's day, then the ledger, and it is idempotent per run ID.

A run that crashes never settles, so its hold stays counted at the full per-run cap. `releaseStaleReservation` clears one, but only for the owner or a cleanup job; nothing calls it automatically. The P1-13 orphans job should also delete `reviews/<repo>/pr-<n>*` once the PR is closed, after any shadow-index export the metrics need.

## Product-repo setup

`globalhost install` will automate this (P1-09). Until then, set it up by hand, once per repo:

1. **Factory side:** make sure the factory infra is applied (P1-04) with the repo in `dispatchRepos`, and that the `globalhost-ai` App is created and installed on the repo (P1-05).
2. **Anthropic Console:** add a federation rule for the repo's dispatcher. Use Connect workload → GitHub Actions with these settings:
   - the same immutable-subject form as the audit's rule;
   - environment `globalhost`;
   - workspace `globalhost-runners`.
3. **In the product repo:**
   - Create an environment `globalhost` whose deployment branches are limited to the default branch.
   - Add these repo variables. They're identifiers, not secrets:

     | Variable | Value |
     |---|---|
     | `GLOBALHOST_WIF_PROVIDER` | stack output `workloadIdentityProvider` |
     | `GLOBALHOST_DISPATCH_SA` | `globalhost-gh-dispatch@globalhost-factory.iam.gserviceaccount.com` |
     | `GLOBALHOST_APP_ID`, `GLOBALHOST_APP_SLUG` | printed by `infra/github-app` |
     | `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_WORKSPACE_ID` | from step 2 |

   - For release observation, add `GLOBALHOST_RELEASE_WIF_PROVIDER` and `GLOBALHOST_RELEASE_SA` (the read-only Cloud Build identity) and commit `.github/workflows/globalhost-release.yml` too.
   - Commit `factory.yaml` and `.github/workflows/globalhost.yml`. In the workflow, the placeholder SHA is replaced with a `globalhost` commit on `main`.
