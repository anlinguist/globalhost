# @globalhost/runner

The runner harness (PLAN P1-06): it drives one factory role through a Claude Managed Agents session (ADR-0011). It turns the session's outputs into a trusted `run.json`. The dispatcher (P1-07) and `globalhost run` both use it.

## What a run does

1. **Read the inputs.** It reads the repo and issue from GitHub, read-only. Text from anyone who isn't an owner is sanitized and fenced as `<untrusted>` data (ARCHITECTURE §4).
2. **Bundle the repo.** It bare-clones the default branch and bundles it with HEAD set. The bundle goes in through the Files API, so the session gets no GitHub credential and no GitHub egress.
3. **Sync the role's agent.** It creates the role's agent, or a new version of it, from `packages/roles`. The prompts and tool settings are hashed into the agent's metadata, and the session pins that version. The environment is `limited`: package registries only.
4. **Run the session.** It starts the session with a server-enforced USD `budget` and sends the task message. It then waits for the turn to end, and survives dropped event streams: every stop decision is reconciled against the session's event log.
5. **Collect the outputs.** It downloads only the allowlisted outputs, each within a size cap: `report.json`, `plan.md`, `result.bundle` and `*.png`.
   - The agent's report is validated and treated as data.
   - The result bundle is fetched into a bare repo, with no checkout and no hooks. It must carry exactly `refs/heads/factory/issue-<n>`, descending from the base.
6. **Write `run.json`** with the status (`succeeded`, `blocked`, `failed`, `cap_exceeded` or `timeout`), cost, outputs and problems.

**Toolchain.** When the caller passes a `toolchain` resolver (the dispatcher builds one from the parts' profiles), the runner calls it on `gitSnapshot` of the run's base commit (for a review, the PR's merge base, what its own CI branched from; the PR head is never read) and validates the result. The task message's Toolchain section states each required version, the command to check it and how to get it. The agent reports what it used in `report.json` `toolchain`; `run.json` `toolchain` records the requirement and a check per tool (`match`, `mismatch`, `unreported`), and each mismatch adds a fixed-text problem. A mismatch never changes the status or, for a review, the verdict. A resolver error is a problem too, and the run goes ahead without versions. A resumed session (`resumeRun`) keeps the first turn's instructions; the harness re-resolves at the stored base commit and checks the resumed turn's report. The check runs only when the turn wrote a report.json.

A **review** (`startReview`, P2-01, ADR-0015) runs the read-only `reviewer` role on one PR head:
- `createReviewBundle` fetches the base branch and `refs/pull/<n>/head`, refuses the review if the head isn't the SHA the caller asked for, and bundles both with HEAD on the head (branch `globalhost-review/pr-<n>`), so the reviewer can diff against the merge base and revert the fix offline. The read-only token is used only for that fetch.
- The PR must target the default branch. The issue title and body (the spec, fenced even when the owner wrote it; comments aren't passed), the PR description and the caller's CI summary go into the task message as `<untrusted>` data.
- Preview screenshots are local PNGs at canonical paths. Each is opened once with `O_NOFOLLOW` (no symlinked file or parent), checked (regular file, size cap, PNG header), copied into a harness-owned directory as `screenshot-NN.png` and mounted at `/mnt/session/uploads/screenshots/`. A caller's label for a screenshot appears only inside a fence.
- The reviewer writes `review-output.json`. It must match core's `ReviewOutputSchema` exactly; anything else (unknown or duplicate keys, a category outside its area, over a limit, not one JSON value, over 1 MiB) is rejected whole, never clipped, and the status is `invalid_output`. `run.json` follows `ReviewRunSchema`.
- Once a session exists, every exit writes `run.json` with its session ID and cost: a harness error interrupts the session and records `failed`, and if that can't be written either, `ReviewRunError` carries the session ID. A caller with a hard job timeout passes it as `hardTimeoutMinutes`; the review's own timeout must leave `REVIEW_SETTLE_MARGIN_MINUTES` (3) for settling.
- Scanning, budgets, the overall verdict and posting are the caller's.

A **resume** sends owner feedback to the same session, which keeps its full context. It tops up the budget by `--budget` on top of what's already spent.

## Local runs (`globalhost run`)

Local runs are keyless (ADR-0014). Your gcloud login mints a Google identity token for `sa:globalhost-local`, a service account with no GCP roles. A Console federation rule exchanges that token for a ~10-minute Anthropic token, in workspace `globalhost-runners`.

**One-time setup:**
1. Create the service account and let yourself mint its identity tokens:
   ```
   gcloud iam service-accounts create globalhost-local --project globalhost-factory --display-name "globalhost local runs"
   gcloud iam service-accounts add-iam-policy-binding globalhost-local@globalhost-factory.iam.gserviceaccount.com \
     --project globalhost-factory --member user:<you> --role roles/iam.serviceAccountOpenIdTokenCreator
   gcloud iam service-accounts describe globalhost-local@globalhost-factory.iam.gserviceaccount.com --format 'value(uniqueId)'
   ```
2. Connect it in Console: Connect workload → Google Cloud.
   - Subject: the unique ID. Claim `email`: the SA email.
   - Workspace `globalhost-runners`, scope `workspace:developer`, 600 s.
3. Export the IDs. They're identifiers, not secrets:
   ```
   export GLOBALHOST_LOCAL_SA=globalhost-local@globalhost-factory.iam.gserviceaccount.com
   export ANTHROPIC_ORGANIZATION_ID=… ANTHROPIC_FEDERATION_RULE_ID=… ANTHROPIC_SERVICE_ACCOUNT_ID=… ANTHROPIC_WORKSPACE_ID=…
   ```

**Usage:**
```
pnpm globalhost run anlinguist/numu-know 12 --role planner --budget 2
pnpm globalhost run anlinguist/numu-know 12 --role builder --plan-file .globalhost/runs/<id>/plan.md
pnpm globalhost run --resume sesn_… --feedback "Use the existing Button component instead."
```

`globalhost assess <owner/repo>` uses the same setup to run the read-only `assessor` role; see `packages/assess/README.md`.

Add `--config <factory.yaml>` to give a local run the same profile guidance and network environment the dispatcher would build. The file can be a draft that isn't committed to the product repo yet; its owners are used unless `--owner-id` is given.

**Skills.** Every registered profile's skill directory (`skills/<name>`) is uploaded as a Managed Agents custom skill and pinned, by version, on both role agents. A skill is named by a hash of its files (`globalhost-web-app <hash>`), so an unchanged skill is reused and an edit uploads a new one and bumps the agents' versions. All agents carry all profile skills, so `roles sync`, local runs and the dispatcher produce the same agent definition.

Outputs land in `.globalhost/runs/<run-id>/`, which is gitignored. To look at a builder's work, fetch its bundle into a clone of the product repo:
```
git fetch <out>/result.bundle factory/issue-12:factory/issue-12
```

Nothing is pushed: publishing is the dispatcher's job (P1-07).
