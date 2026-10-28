# ADR-0012: Scheduled LLM security audit (Actions now, runner later)

- Status: accepted
- Date: 2026-10-28

## Context

Audit run-1 (2026-10-28, Cloudflare's `security-audit` skill, quick profile) found no confirmed vulnerabilities. It produced hardening notes and, while it ran, caught live-product details in the public docs. The owner wants the audit to be part of CI and of the factory process.

Constraints:
- **This repo is public.** Actions logs and artifacts are world-readable, so audit output must never reach either. Findings go only to private `globalhost-ops` (ONBOARDING §8).
- **Secrets live in GCP Secret Manager** (CLAUDE.md #5).
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
   - Workflow `.github/workflows/security-audit.yml` runs weekly (Mon 06:17 UTC) and on `workflow_dispatch`, only on `main`.
   - It runs the `claude -p` CLI. The binary comes from the npm registry tarball, pinned by SHA-256 and at least 14 days old.
   - Run settings: quick profile, model `claude-opus-5-5`, `--max-budget-usd 10`, 60-minute job timeout.
   - Tool allowlist: read and search; writes only through the Write/Edit tools; read-only `git`; the skill's two validators.
   - Denied: WebFetch, WebSearch, and every other shell command.
   - The prompt tells it to execute no target code. The runner can't provide the skill's OS-sandbox limits, so runs are source-only.
3. **Two jobs, two identities**, both via keyless Workload Identity Federation (pool `github`, provider pinned to owner ID + `anlinguist/globalhost` + `refs/heads/main`). Each service account trusts only the OIDC subject of one GitHub environment.

   | Job | Environment | SA | Can |
   |---|---|---|---|
   | `audit` (runs the agent) | `security-audit` | `globalhost-auditor` | read `security-audit-anthropic-key`; read and create objects in the report bucket (no delete or overwrite) |
   | `publish` (no checkout, runs no repo code) | `security-audit-publish` | `globalhost-audit-publisher` | read the report bucket; read `globalhost-ops-issues-token` (fine-grained PAT: Issues RW on `globalhost-ops` only) |

   The agent can reach its API key and the auditor SA. That is the accepted blast radius: the key is capped by the `globalhost-runners` workspace limit, and the SA can only add reports. The agent can't reach the publisher identity, because the OIDC subject for its job names a different environment.
4. **Output.**
   - Agent output goes to files, never to the log.
   - Files upload to a private bucket, `gs://globalhost-factory-audit-reports/globalhost/<UTC timestamp>-<sha>/audit/`. It has public-access prevention and a 180-day delete rule.
   - The publisher files `REPORT.md` as an issue in `globalhost-ops`, or a "FAILED" issue if no report was produced.
   - Each run gets the previous run's files for the skill's prior-run comparison.
5. **Cost.** The expected cost is a few dollars per weekly run, with a hard cap of $10. That is at most about $43 per cycle out of the $150 `globalhost-runners` workspace. The run cap is above ADR-0004's $4 per-run default, on purpose: an audit is one large reviewer-class run. The bucket costs cents. No other paid resources.
6. **Later.**
   - Once the runner exists (P1-05+), the audit becomes a factory role run by the runner, and this workflow is retired.
   - The assessor (P1-08) runs a full audit when onboarding a product. Product findings go to that product's own private destination, never to a public repo.
   - Infra moves from `infra/bootstrap/security-audit.sh` to Pulumi in P1-04.

## Consequences

- **Owner setup, once:**
  - run `infra/bootstrap/security-audit.sh`;
  - set the repo variables it prints;
  - create the GitHub environments `security-audit` and `security-audit-publish`, both limited to `main`;
  - add the two secret values.

  Until then the workflow fails at authentication and does nothing else.
- **Manual pin bumps.** The Claude Code and CI tool pins (`env:` in the workflows) aren't Renovate-managed. Bump them by hand: new URL, plus the SHA-256 checked against the publisher's checksum or the registry integrity.
- **Not continuous.** A weekly audit misses changes between runs. Per-PR gates stay deterministic: zizmor, actionlint, gitleaks, ESLint boundary.
- **Prompt injection.** The agent reads repo content that only the owner can merge to `main`. Even so, a hijacked run can only spend up to its cap and add a report. It can't edit the repo, publish, or reach the ops token.
