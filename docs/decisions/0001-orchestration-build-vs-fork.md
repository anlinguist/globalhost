# ADR-0001: Orchestration — build our own, borrow patterns

- Status: proposed
- Date: 2026-10-27

## Context

Three reference factories were evaluated (read via `gh api`, nothing executed):

| | addyosmani/factory | thegpvc/gp-foundry | kunalm2345/openfactory |
|---|---|---|---|
| What it is | installer of Markdown skills/agents/settings; no runtime | TS compiler: `harness.dot` graph → GitHub Actions workflows + runtime actions | Node/Hono server + SQLite state machine + dashboard, locked to ascii.dev Box VMs |
| Activity | 301★, 1 maintainer, burst Aug 2026 | 1★, 1 maintainer, active (v0.2.9, Oct 2026) | 5★, 1 maintainer, quiet since Aug 2026 |
| License | MIT | MIT | MIT |
| Trigger | Claude cloud routines (hourly poll) + optional Action | GitHub events + cron, `claude -p` in Actions | HMAC webhooks (GitHub, Linear, Sentry) |
| Builder/grader split | verifier subagent in same session | separate jobs, but shared PAT identity | separate fresh VM, different model, `REVIEW.json` |
| Security | prompt-level + settings deny list | strongest: input sanitizer, immutable paths, zizmor/actionlint | weak: account-wide token in every box |
| Default merge | never automated | auto-merge | dashboard gate |

## Decision

**Build our own thin orchestration; fork nothing; vendor/borrow specific pieces.**

- `factory` has no runtime and depends on Anthropic-hosted routines, not our Cloud Run runners.
- `gp-foundry` is closest in shape, but its DOT-graph compiler is more abstraction than a solo factory needs, doesn't model per-repo profiles, defaults to auto-merge, uses a PAT, and is a one-star, single-maintainer 0.x project. Forking means owning ~3k lines of compiler.
- `openfactory` is vendor-locked and stateful, the opposite of "thin layer over GitHub."

Borrow:
1. Label state machine + machine-readable handoff comment + "first non-force push of the branch claims the work" — `addyosmani/factory: template/docs/factory/CONTRACT.md`.
2. Fail-closed gate script with a fixed verdict line agents must quote — `template/.claude/scripts/gates.sh`.
3. Cold verifier + revert-the-fix test proof — `template/.claude/agents/factory-verifier.md`, `template/.factory/scripts/prove-test.sh` — run as a **separate job** (our reviewer role).
4. Tiers / load-bearing globs / review-queue cap — `template/docs/factory/CHARTER.md` → our L0–L3 and `guardrails.loadBearing`.
5. Untrusted-input sanitizer + context formatter — `gp-foundry: actions/sanitize-untrusted-input/src/sanitize.ts`, `actions/agent-context/src/formatters.ts` (vendor into `packages/sanitize`, keep MIT notice).
6. Policy merge gate (approval tied to head SHA, size caps, protected paths) — `actions/merge-gate/src/gate.ts`, `policy/merge.yaml`.
7. Immutable paths enforced in CI; zizmor + actionlint — `scope.yaml`, `immutable-guard.yml`.
8. Supervisor/janitor sweeps with capped retries — `roles/software/supervisor.md`, `janitor.md`.
9. Reviewer isolation + `REVIEW.json` findings schema — `openfactory: prompts/review.md`.

Improve on all three: a GitHub App identity (not PAT), agents hold no write credentials (publisher pattern), per-run $ caps.

## Consequences

We own orchestration code, but it stays small (dispatcher workflow + harness + publisher). Re-check `gp-foundry` at Phase 2 — if it matures, its runtime actions could be consumed as a dependency rather than vendored.
