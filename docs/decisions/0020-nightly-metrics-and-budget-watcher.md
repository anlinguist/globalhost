# ADR-0020: Nightly metrics go to an issue and a bucket, and the budget watcher fails the job

- Status: accepted
- Date: 2026-11-04
- Relates to: ADR-0004 (budget), ADR-0014 (no API keys), ADR-0016 (identities pinned to the default branch's workflow)

## Context

P1-13 planned a nightly job that commits `docs/metrics.md` and checks the daily spend against the Anthropic Console. A nightly commit to `main` would need a write path around the main ruleset, for a file nobody edits. The Console check as written needs Anthropic's Admin cost API, and that needs an API key, which ADR-0014 rules out. This repo is public, so its issues, Actions logs and anything committed are public too, while the data comes from `run.json` files that hold agent-written text and can name private product repos.

## Decision

- **Output.** `.github/workflows/nightly.yml` (schedule and `workflow_dispatch`, main only) runs `globalhost metrics`. It writes `gs://globalhost-control/metrics/<day>.json` and edits one rolling issue in this repo, title "Factory metrics", label `factory:metrics`, through `GITHUB_TOKEN`. This replaces `docs/metrics.md`. `<day>` is the last complete UTC day, and every total runs through it, so the numbers are final and a re-run gives the same ones.
- **Everything published is aggregate, because it's public.** Nothing agent-written leaves. The job reads only numeric and enum fields from `run.json`, plus repo names that pass the slug regex. It never uses `report`, `problems`, `stopReason`, `model` or any other free-text field. A repo that isn't confirmed public (private, unreadable by the token, or any error asking) is rolled up as `other`, in every table and finding, and doesn't fail the job. Errors logged by the job carry fixed text and an HTTP status, never an object name or API path, because those can name a private repo. Object names of records it couldn't use go only to `metrics/<day>.problems.json` in the private bucket.
- **Its own identity, `sa:globalhost-gh-nightly`.** WIF provider `github/globalhost-nightly` accepts only `nightly.yml` on main in this repo (`job_workflow_ref` and `workflow_ref`), for its two triggers, on a GitHub-hosted runner. It has `objectViewer` on `globalhost-runs` and `globalhost-control`, and `objectUser` conditioned on the `metrics/` prefix of the control bucket. It has no other write and no project-level role. Install and build run before its GCP login.
- **Budget cycle:** the 10th to the 9th, UTC, cap $150 (ADR-0004), committed as constants in `packages/dispatch/src/metrics.ts`. Days 1-9 belong to the cycle that began on the previous 10th.
- **Budget watcher.** After publishing, the job fails, so GitHub emails the owner, and the issue lists why, when any of these holds:
  1. cycle-to-date ledger spend is at least 80% of the cap;
  2. the straight-line projection to cycle end exceeds the cap, from day 5 of the cycle;
  3. the last complete day, all repos together, is at least 80% of the default `limits.dailyUsd` ($20 in the schema; ADR-0004's $15 was never what shipped);
  4. over the trailing 7 complete days, the per-turn deltas from `run.json` differ from the ledger by more than max($1, 10% of the ledger). The difference is taken per repo and added up as absolute values, so one repo's excess can't cancel another's shortfall. It compares over a window, not per day, because a run can cross midnight. This compares two records of the same run, so it only sees a gap between them: see the limits below;
  5. a corrupt record in `spend/`, or a `run.json` that fails its schema or disagrees with its object name. These are reported, never skipped;
  6. an open reservation older than 24 hours.

  If the job can't read a bucket, it fails without publishing.
- **Console reconciliation is a manual owner check.** No Admin API (ADR-0014). The issue prints cycle-to-date; the owner compares it with the `globalhost-runners` workspace and records the result in PLAN P1-13. Known unledgered spend (`security-audit.yml`, local `globalhost run` and `assess`, and builders that died mid-session) makes the Console read higher.
- **`metrics/` objects are deleted after 400 days**, by a lifecycle rule limited to that prefix.

## Consequences

- **Drift doesn't see a builder that dies mid-session.** `dispatch.ts` calls `recordSpend` and `archive` only after `startRun` or `resumeRun` returns. A builder job that's killed, times out at the Actions level, or throws leaves neither record, so drift stays at $0 while the session's spend is real. **Spend from crashed builders is visible only in the Console, and the Console workspace limit remains the hard cap.** What drift does catch is the gap between `recordSpend` and `archive`, and the failed reviews below. Follow-up in PLAN P1-13: record builder spend or a reservation before the session starts.
- **A failed review trips drift until it ages out.** A review that fails with no session cost to go on settles up to its cap with no `run.json` (`review.ts`). The ledger is right, because a session may have spent that, but run records are short by it. If that's over the threshold, the job stays red until the day leaves the 7-day window, and review $/PR omits the amount. The finding names this as a possible cause. Follow-up in slice 2: archive a run record for failed reviews.
- **A midnight crossing at the window's edge can trip drift for a day.** A run that finishes just before the window opens while its spend lands just inside it (or the reverse at the other edge) counts on one side only. It's within the $1 floor unless the run was costly, and it clears on the next night's window.
- **A resumed turn with no baseline turns the drift finding off.** When turn 1 has aged out, the run-record side is known to be short, so the finding is suppressed while that turn is in the window, and the issue says the check didn't run. Real drift in those 7 days goes unreported until the turn leaves the window.
- **Reservations are only seen within the spend window.** Condition 6 reads the spend records of the current cycle and drift window, so an older unsettled reservation drops out of the report, having been red for at least 7 days. Holds in the PR ledgers under `reviews/` aren't read at all. Both are slice-2 limits: that slice's cleanup reads those ledgers and releases stale holds.
- **The owner's main-branch ruleset stays as it is.** Nothing commits nightly, and `GITHUB_TOKEN` can't push from this job (`contents: read`).
- **The job's `GITHUB_TOKEN` can write any issue in this repo.** Its code is pinned to main and takes no untrusted input as instructions, so that scoping is self-restraint in trusted code, as with `REVIEW_PERMISSIONS` (ADR-0018).
- **`objectUser` includes delete under `metrics/`,** because overwriting a day's report needs it. A subverted job could remove old reports; the bucket's versioning keeps them for 30 days. The ledger and kill switch are out of its reach.
- **Run records last 30 days (lifecycle), and a cycle can be 31.** Late in a long cycle, its run-derived numbers (run counts, redirects, review cost) can miss the first days, and the issue says so. Ledger spend, drift and every watcher condition on spend aren't affected. A resumed run whose first turn has aged out has no known baseline: it's counted as a redirect but adds no cost to the run-record figures, and the issue notes it.
- **A corrupt record stays red until the owner fixes or deletes it.** Corrupt spend records are only looked at within the current cycle and drift window.
- **GitHub disables scheduled workflows after 60 days without repo activity.** If the factory repo goes quiet the watcher stops silently, until someone re-enables it.
- **Cost.** One WIF provider and one service account are free, and these are small objects in an existing bucket. Actions minutes are free on a public repo. No new paid resource.
- **Owner setup:** `pulumi up`, then repo variables `GCP_NIGHTLY_WIF_PROVIDER` and `GCP_NIGHTLY_SA`, from `pulumi stack output nightlyWorkloadIdentityProvider` and `nightlyServiceAccount`. The job fails until both are in place.
