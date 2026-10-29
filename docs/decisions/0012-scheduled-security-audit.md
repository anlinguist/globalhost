# ADR-0012: LLM security audit (Actions now, runner later)

- Status: accepted; amended 2026-10-28 to run on demand only, after the first real run was much slower and costlier than expected.
- Date: 2026-10-28

## Context

Audit run-1 (2026-10-28, Cloudflare's `security-audit` skill, quick profile) found no confirmed vulnerabilities. It produced hardening notes and, while it ran, caught live-product details in the public docs. The owner wants the audit to be part of CI and of the factory process.

Constraints:
- **This repo is public.** Actions logs and artifacts are world-readable, so audit output must never reach either. Findings go only to private `globalhost-ops` (ONBOARDING §8).
- **Secrets live in GCP Secret Manager** (CLAUDE.md #5), and fewer secrets is better.
- **Agents hold no write credentials** (CLAUDE.md #3).
- **Auth and billing (ADR-0004).** Unattended runs use an API key from the linked Console org, which the monthly credit covers. `anthropics/claude-code-action` usage isn't covered, so it is not used.
- **No runner yet.** The factory runner (ADR-0011, Cloud Run Job or Managed Agents) doesn't exist until P1-05.

## Decision

1. **Vendor the skill** at `skills/security-audit/`.
   - It is unmodified, MIT notice kept.
   - Its provenance is in `SOURCE.txt`.
   - Updates are a reviewed copy of a pinned upstream commit.
   - It is excluded from ESLint so it stays byte-for-byte.
2. **Interim host: GitHub Actions.**
   - Workflow `.github/workflows/security-audit.yml` runs only on `workflow_dispatch`, only on `main`. There is no schedule. The owner runs it before releases, after large or security-relevant changes, or when it seems worth it.
   - It runs the `claude -p` CLI. The binary comes from the npm registry tarball, pinned by SHA-256 and at least 14 days old.
   - Run settings: quick profile, model `claude-opus-5-5`, `--max-budget-usd 15`, 60-minute job timeout.
   - **Containment is enforced by the CLI and the filesystem, not by the prompt.** The first real run showed that `--allowedTools` alone denies nothing that's missing from the list. So the agent runs with:
     - `--restricted`: settings files are ignored, file tools are confined to the working directories, and writes to git and settings files are blocked;
     - `--tools Bash,Read,Write,Edit,Glob,Grep,Agent`: no web or other tools;
     - `--permission-mode dontAsk`: any Bash command not on the allowlist is refused, including chained ones;
     - the allowlist itself: the skill's two validators, `mkdir` and `ls`.
   - **No git command.** Allowlist rules match command prefixes, and several options of "read-only" git subcommands write files or run programs (`--output`, `grep -O`, `--ext-diff`). Trusted code exports the history as text before the agent starts (commit log with changed files, full patch log capped at 20 MB, file list), and the agent reads that instead.
   - The checkout, the skill copy, the git export and the prior run are `chmod -R a-w` before the agent starts. The output directory is the only writable path.
   - The agent reads `SKILL.md` directly, because `--restricted` doesn't load user skills.
   - These behaviors were verified locally before adoption: an unlisted command, a chained command, a write outside the allowed directories, a write into the read-only checkout or skill, and an edit to `.git/config` were all refused.
   - The prompt also tells it to execute no target code. The runner can't provide the skill's OS-sandbox limits, so runs are source-only.
3. **Two jobs, two identities**, both via keyless Workload Identity Federation (pool `github`, provider pinned to owner ID, repo ID, `anlinguist/globalhost` and `refs/heads/main`). Each service account trusts only tokens whose `environment` claim is its own GitHub environment.

   | Job | Environment | SA | Can |
   |---|---|---|---|
   | `audit` (runs the agent) | `security-audit` | `globalhost-auditor` | read the report bucket; create objects only under `globalhost/runs/` (no delete or overwrite); no secrets |
   | `publish` (no checkout, runs no repo code) | `security-audit-publish` | `globalhost-audit-publisher` | read the report bucket; read `globalhost-ops-issues-token` (fine-grained PAT: Issues RW on `globalhost-ops` only) |

4. **Anthropic auth is Workload Identity Federation, not an API key.**
   - A Console service account (`security-audit`) is a member of the `globalhost-runners` workspace only.
   - Its federation rule (`globalhost-security-audit`) matches:
     - issuer `https://token.actions.githubusercontent.com`;
     - audience `https://api.anthropic.com`;
     - the exact subject `repo:anlinguist@47403803/globalhost@1437394155:environment:security-audit`. GitHub uses immutable, ID-qualified subjects for this repo.
     - claims `repository_owner_id=47403803`, `repository=anlinguist/globalhost` and `ref=refs/heads/main`;
     - a CEL condition limiting it to `schedule` and `workflow_dispatch` runs of `.github/workflows/security-audit.yml`.
   - Scope `workspace:developer`, token lifetime 600 s.
   - The CLI exchanges the job's GitHub OIDC token itself. A background loop rewrites the token file every 4 minutes, because GitHub tokens last about 5 minutes and each can be exchanged once.
   - Org, rule, service-account and workspace IDs are repo variables. They are identifiers, not credentials.

   Blast radius: the agent can mint tokens of about 10 minutes for that workspace while the job runs (capped by its spend limit), and it can use the auditor SA, which can only add reports. It can't reach the publisher identity, because its job's `environment` claim is `security-audit`. The run leaves no long-lived credential to steal.
5. **Output.**
   - Agent output goes to files, never to the log.
   - Files upload to a private bucket, `gs://globalhost-factory-audit-reports/globalhost/runs/<UTC timestamp>-<sha>-<nonce>/audit/`. The random nonce is chosen before the agent starts and never given to it, so a run can't pre-create objects under a later run's name (the auditor SA can create anywhere under `runs/`). It has public-access prevention and a 180-day delete rule.
   - The publisher files `REPORT.md` as an issue in `globalhost-ops`, or a "FAILED" issue if no report was produced.
   - Each run gets the previous run's files for the skill's prior-run comparison. The previous run is named by `globalhost/published/latest`, a pointer only the publisher can write (an IAM condition scoped to that one object). The publisher updates it only after filing a run that produced a report. The audit job checks the pointer against a strict format and treats a missing or malformed pointer, or a failed fetch, as "no prior run". A run can't choose what later runs treat as prior by planting objects.
   - `publish` also runs when the audit job fails, so failures still file an issue. It files `REPORT.md` and advances the pointer only when the audit job, including its upload, succeeded; otherwise it files a "FAILED" issue and leaves the pointer alone.
6. **Cost.** Each run is capped at $15 (raised from $10 after two quick runs hit it and one skipped candidate validation). Runs are on demand, so spend is whatever the owner chooses, within the $150 `globalhost-runners` workspace. The run cap is above ADR-0004's $4 per-run default, on purpose: an audit is one large reviewer-class run. The bucket costs cents. No other paid resources.
7. **Later.**
   - Once the runner exists (P1-05+), the audit becomes a factory role run by the runner, and this workflow is retired.
   - The assessor (P1-08) runs a full audit when onboarding a product. Product findings go to that product's own private destination, never to a public repo.
   - Infra moves from `infra/bootstrap/security-audit.sh` to Pulumi in P1-04.

## Consequences

- **Owner setup, once:**
  - run `infra/bootstrap/security-audit.sh`;
  - set the repo variables it prints;
  - create the GitHub environments `security-audit` and `security-audit-publish`, both limited to `main`;
  - connect the Anthropic workload (decision 4) and set its four repo variables;
  - add the `globalhost-ops` token value.

  Until then the workflow fails at authentication and does nothing else.
- **Manual pin bumps.** The Claude Code and CI tool pins (`env:` in the workflows) aren't Renovate-managed. Bump them by hand: new URL, plus the SHA-256 checked against the publisher's checksum or the registry integrity.
- **Not continuous.** An on-demand audit only sees the commit it runs on. Per-PR gates stay deterministic: zizmor, actionlint, gitleaks, ESLint boundary.
- **Billing.** Federated tokens bill to the workspace like an API key, so usage should draw on the linked credit the same way (ADR-0004). Check this on the Console usage page after the first run.
- **Prompt injection.** The agent reads repo content that only the owner can merge to `main`. Even so, a hijacked run can only spend up to its cap and add a report. It can't edit the repo, publish, or reach the ops token.
