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

## Review control state (P2-01)

`ControlPlane` also holds the reviewer's state in `gs://globalhost-control/reviews/<owner>/<name>/` (repo lowercased; repo, PR number, SHA and run ID are validated before they go into an object name; the SHA must be 40-hex, so a SHA-256 repository fails closed):

- **`pr-<n>/<sha>.claim.json`:** one live review attempt per head SHA. `reviewClaim(head, runId, { perRunMinutes, rereview })` creates it (create-only). An uncompleted claim older than `minReviewStaleMinutes(perRunMinutes)` (= `perRunMinutes` + 30) is a crashed run and is taken over by compare-and-swap. The claim stores the `perRunMinutes` it was taken with, and staleness is judged by that, so lowering the limit mid-run can't cut a live claim short (claims without it use the current value). A completed claim is replaced only with `rereview` (an owner's `factory:review`), as the next `attempt`; a re-review never displaces an in-flight one. A corrupt claim is never taken over (`reason: "corrupt"`).
- **`pr-<n>.json`:** the PR's review ledger and shadow index (`ReviewLedgerSchema` in core): settled spend, open reservations, and one `ShadowEntry` per run (runs past 200 drop off, their cost kept in `truncatedSpendUsd`). A corrupt ledger counts as over budget and is never overwritten.
- **Daily spend:** reviews share `spend/<day>/<repo>.json` with builders. Open review reservations sit there too, and `spentTodayUsd` counts them.

**Contract for the review step** (also at the top of the review section in `src/gcp.ts`):

1. `reviewClaim`. If it isn't claimed, don't run and don't reserve, so a duplicate trigger costs nothing.
2. `reserveReview(head, runId, { perRun, perPr, dailyUsd })` before anything runs. It holds `reviewPerRunUsd` on the PR ledger and then on the day's spend record. If either is refused, don't run; record a budget-exhausted review, which escalates.
3. Archive under `reviewArchivePrefix(head, runId)` in `globalhost-runs` (`<repo>/reviews/pr-<n>/<sha>/<runId>/`), per attempt.
4. `recordReviewRun` **always** once claimed, with the actual cost (0 if nothing ran, the per-run cap if a session may exist and its cost is unknown). It settles the reservation on the reservation's day, then the ledger, and it is idempotent per run ID.
5. `completeReviewClaim(head, runId)`, only after archiving. Post the GitHub review only if it returned true.

## Review steps (P2-01, shadow mode)

`globalhost dispatch review-gate` and `globalhost dispatch review` are the steps of the installed review workflow, `templates/.github/workflows/globalhost-review.yml`, run through `packages/action` (`step: review-gate` / `step: review`). Why it has its own environment and identities: ADR-0018. `src/review.ts`:

```
workflow_run (globalhost-ci completed) / pull_request_target labeled factory:review
  └─ review-gate  (read-only GITHUB_TOKEN)  decideReview → review | unlabel | ignore, pr, timeout (= limits.perRunMinutes)
  └─ unlabel      (GITHUB_TOKEN pull-requests: write; no environment)  remove the refused factory:review
  └─ review       (environment globalhost-review)
       decideReview again with its own reads → validate the step's environment → kill switch → claim → reserve
       bundle base + PR head once (read-only token) → diff, commits, paths, patch-id
       CI summary (jobs, steps, log tails; capped) + CI `smoke` artifact screenshots (zip parsed in memory)
       scanDiff over diff, commits, paths and the CI summary → startReview (budget reviewPerRunUsd)
       ReviewRecord via overallVerdict → archive create-only → settle → complete claim → post
```

- **Who triggers it.** A same-repo PR from `factory/issue-<n>` into the default branch, opened by `<GLOBALHOST_APP_SLUG>[bot]` (type Bot), open, with its head equal to the CI run's head; the CI run must be `globalhost-ci` (`.github/workflows/globalhost-ci.yml`) for a `pull_request` event, and its actor and triggering actor the bot or an owner. `factory:review` counts only when an owner applies it; it re-reviews the current head if CI succeeded on it, and is removed once acted on (also when refused). Only that path re-reviews a SHA. Reviews don't take a builder slot.
- **Inputs are untrusted and capped before scanning.** The CI summary is at most 18 000 characters (job list ≤ 5 000, an equal share of the rest per job's log tail, logs read at most 64 KB from the end), with timestamps, control characters and ANSI escapes removed and secrets masked. Screenshots are PNGs under `screenshots/` in the CI run's `smoke` artifact: at most 20, 10 MB each, 50 MB zipped; `readZip` refuses symlinks, special files, traversal, duplicates, zip64, encryption and size lies, and nothing from the zip is written except the chosen PNGs, under harness names in a realpath'd directory. Entry names are passed as untrusted labels. Downloads time out after 60 s per request and body, and the CI logs (fetched 4 at a time) and the artifact share one 3-minute deadline, past which the review goes ahead with what was read (`inputsDeadlineReached` in `inputs.json`). Issue comments are never passed.
- **Smoke artifact contract (for PR 5 and each profile's CI).** Only entries whose path starts with `screenshots/` are read. `actions/upload-artifact` strips the least common ancestor of its `path`s, so the artifact must be uploaded from a parent directory with the screenshots in a `screenshots/` subdirectory, alongside at least one other path (as numu-know's CI does: `playwright-report`, `test-results`, `screenshots`). Uploading `screenshots/` alone would flatten its entries to the root, and the review would see no screenshots.
- **Harness checks.** The scan covers the diff, commit messages and paths, plus the CI summary, the PR title and body, and the screenshot labels. A finding whose `file` isn't in the diff has its file and line cleared (the original is in `inputs.json`). Any scan hit escalates. Verdicts come only from `overallVerdict` over the validated output.
- **Timeouts.** The job's deadline is `GLOBALHOST_JOB_STARTED_AT` (epoch seconds, recorded by the job's first step and passed to this one; without it, 5 min before this step) plus `GLOBALHOST_JOB_TIMEOUT_MINUTES` (≤ `limits.perRunMinutes`). startReview gets `deadlineEpochMs` = that deadline less 2 min for archiving, settling and posting. The runner cuts the turn at `deadlineEpochMs` less its 3-minute settle margin, however long the clone, agent sync and uploads took, and keeps the interrupt and settle waits inside it.
- **Cost when it fails.** A failure before a session could exist (`ReviewNotStartedError`, or anything before startReview) settles at $0. A `ReviewRunError` settles at its cost. Any other startReview failure settles at `reviewPerRunUsd`, since a session may exist with an unknown cost.
- **Posting.** One review per head SHA, event `COMMENT` on that commit, found again by the first-line marker `<!-- globalhost:review {"sha","run"} -->` on the bot's own reviews and updated in place. Reviewer text is shown only in code spans and fenced blocks it can't close, with control and bidi characters stripped and HTML comment delimiters broken, so it can't mention, link, close issues, inject HTML or forge a marker. An escalation adds `needs:owner-approval`; the reasons are fixed text. The token is minted by `reviewInstallationToken` with `REVIEW_PERMISSIONS` (issues and pull requests write, metadata read; no contents), through its own seam (`reviewToken`), never the publisher's `appToken`. A PR with more than 3 000 reviews is refused rather than risk a duplicate post.

Step environment: `GITHUB_*`, `RUNNER_TEMP`, `GLOBALHOST_APP_ID`, `GLOBALHOST_APP_SLUG`, `GLOBALHOST_JOB_TIMEOUT_MINUTES`, `GLOBALHOST_JOB_STARTED_AT`, the job's OIDC request variables, and the Anthropic federation variables of the review's own rule (`ANTHROPIC_FEDERATION_RULE_ID` and `ANTHROPIC_SERVICE_ACCOUNT_ID` come from the repo variables `ANTHROPIC_REVIEW_FEDERATION_RULE_ID` and `ANTHROPIC_REVIEW_SERVICE_ACCOUNT_ID`). `review` checks all of them before it claims, so a misconfigured repo fails without stranding a claim for `perRunMinutes` + 30. `review-gate` needs only `GITHUB_*`, `GITHUB_TOKEN` and `GLOBALHOST_APP_SLUG`, and outputs `action` (`ignore | review | unlabel`), `pr` and `timeout`.

**Workflow** (`globalhost-review.yml`). The `gate` job has a read-only `GITHUB_TOKEN` (contents, pull requests, actions) and no environment. The `unlabel` job runs only for `unlabel` (an owner's `factory:review` that's refused, e.g. because a review of that SHA is in flight). Its token can only write pull requests, it has no environment and no concurrency group, and it only removes the label with `gh api`, so it can't displace a review waiting in the PR's group. The `review` job runs only for `review`, in the environment `globalhost-review`, with `timeout-minutes` set to the gate's `timeout`. Its token is read-only (contents, issues for the spec issue, pull requests, actions) plus `id-token: write`, it uses GCP WIF as `sa:globalhost-gh-review`, and it runs with `concurrency: globalhost-review-pr-<n>`, `cancel-in-progress: false`. GitHub keeps only the newest waiting run per group, so an owner's `factory:review` that was replaced while waiting stays on the PR: remove it and apply it again.

A run that crashes never settles, so its hold stays counted at the full per-run cap. `releaseStaleReservation` clears one, but only for the owner or a cleanup job; nothing calls it automatically. The P1-13 orphans job should also delete `reviews/<repo>/pr-<n>*` once the PR is closed, after any shadow-index export the metrics need.

## Product-repo setup

`globalhost install` will automate this (P1-09). Until then, set it up by hand, once per repo:

1. **Factory side:** make sure the factory infra is applied (P1-04) with the repo in `dispatchRepos`, and that the `globalhost-ai` App is created and installed on the repo (P1-05).
2. **Anthropic Console:** nothing to add. The dispatcher's and the reviewer's federation rules each cover every repo of the owner (ADR-0014), so reuse the existing rule and service-account IDs as repo variables. They're kept outside this public repo.
3. **In the product repo:**
   - Create an environment `globalhost` whose deployment branches are limited to the default branch.
   - Add these repo variables. They're identifiers, not secrets:

     | Variable | Value |
     |---|---|
     | `GLOBALHOST_WIF_PROVIDER` | stack output `workloadIdentityProvider` |
     | `GLOBALHOST_DISPATCH_SA` | `globalhost-gh-dispatch@globalhost-factory.iam.gserviceaccount.com` |
     | `GLOBALHOST_APP_ID`, `GLOBALHOST_APP_SLUG` | printed by `infra/github-app` |
     | `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_WORKSPACE_ID` | the existing dispatcher rule's (step 2) |

   - For release observation, add `GLOBALHOST_RELEASE_WIF_PROVIDER` and `GLOBALHOST_RELEASE_SA` (the read-only Cloud Build identity) and commit `.github/workflows/globalhost-release.yml` too.
   - For reviews (P2-01, shadow; ADR-0018):
     - add the repo to `reviewRepos` in `infra/factory` (GitHub's canonical `owner/name` casing) and apply;
     - create an environment `globalhost-review` whose deployment branches are limited to the default branch, with **no** required reviewers, **no** wait timer and **no** environment secrets. Everything it needs is a repo variable or comes from WIF. A reviewer or wait timer would hold the job past its claim window;
     - add the variables `GLOBALHOST_REVIEW_WIF_PROVIDER` and `GLOBALHOST_REVIEW_SA` (stack outputs `reviewWorkloadIdentityProvider` and `reviewServiceAccount`), plus `ANTHROPIC_REVIEW_FEDERATION_RULE_ID` and `ANTHROPIC_REVIEW_SERVICE_ACCOUNT_ID` (the existing review rule's IDs; no Console setup);
     - create the label `factory:review`;
     - make sure CI uploads the `smoke` artifact as described above;
     - commit `.github/workflows/globalhost-review.yml`.

     The App's permissions already cover `REVIEW_PERMISSIONS`.
   - Commit `factory.yaml` and `.github/workflows/globalhost.yml`. In the workflow, the placeholder SHA is replaced with a `globalhost` commit on `main`.
