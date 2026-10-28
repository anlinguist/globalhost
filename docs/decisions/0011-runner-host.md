# ADR-0011: Runner host — Claude Managed Agents first, Cloud Run Job as fallback

- Status: proposed (gated on spike P1-00)
- Date: 2026-10-27

## Context

The Max credit covers **Claude Managed Agents** (ADR-0004). Managed Agents (beta, `managed-agents-2026-04-01`) is a hosted agent harness with a per-session Linux sandbox:
- **Sandbox:** Ubuntu 24.04; Node 22 + pnpm/npm/bun; Playwright with **Chromium** preinstalled; up to 8 GB RAM / 10 GB disk.
- **Network:** `limited` mode with `allowed_hosts` + `allow_package_managers`. Omitting `networking` in the API means **unrestricted**, so it must always be set.
- **Repos:** `github_repository` resources cloned at session start using a token you supply.
- **Secrets:** vaults whose `environment_variable` credentials are **substituted at egress**, so the agent never sees the value. MCP servers can authenticate via vault.
- **Budget:** a server-enforced **per-session USD budget**; at the cap the session idles with `budget_reached`. One in-flight request can overshoot.
- **Sessions persist:** an idle session accepts a new message. Outputs go to `/mnt/session/outputs/`, readable via the Files API.
- **Pricing:** tokens at list price + **$0.08 per running session-hour** (idle is free). The support article lists Managed Agents as covered by the credit; whether the runtime fee is also drawn from it is **not yet verified**.
- **Unknowns:** CPU count, max session duration, and egress-injected git credentials are undocumented. It's not eligible for ZDR (fine for us).

Compared with our own Cloud Run Job runner, this gives:
- $0 GCP runner cost;
- no runner image to maintain;
- a stronger per-run cap (server-side instead of the SDK's client-side estimate);
- secrets the agent can't read (vault egress substitution);
- **resumable sessions**, so a redirect comment can continue the builder's session with its full context instead of starting cold. That's cheaper and better.

## Decision

- **Primary runner: Managed Agents.** One agent definition per role (planner, builder, reviewer, fixer, triager), versioned in `packages/roles` and synced by `globalhost roles sync`. One `limited` environment per profile (package managers + allowlisted hosts).
- **Same credential rule as before.** Sessions get a **read-only** installation token for the clone (or none for public repos). The agent writes a git bundle + `run.json` to `/mnt/session/outputs/`. The trusted publisher fetches them via the Files API and pushes to `factory/*`. Dev-integration secrets go in vaults (egress-injected). No prod secrets ever go in a vault an agent session can use.
- **Redirects resume sessions.** The dispatcher stores `sessionId` in the PR's handoff comment. An owner comment sends a `user.message` to that session (with a new budget top-up) instead of creating a new one. Sessions are deleted after merge/close, after outputs are archived to GCS.
- **Fallback: Cloud Run Job runner** with the same input/output contract (`run.json` + bundle). Used if the spike fails a requirement, for jobs that exceed sandbox limits, or if Managed Agents is unavailable. The harness is written against a `RunnerHost` interface so both hosts are interchangeable.
- **Explicit settings:** `networking.type: limited` always, permission policy `always_allow` for the agent toolset inside the sandbox (the sandbox *is* the boundary), MCP toolsets limited per role.

## Spike P1-00 (go/no-go)

Run one real numu-know issue end-to-end on Managed Agents. Pass criteria:
1. Console shows both token and session-runtime charges coming out of the monthly credit.
2. `pnpm i && pnpm build && playwright test` runs inside the sandbox in under 15 min.
3. With `limited` networking, a `curl` to a non-allowlisted host fails.
4. The bundle round-trips through the Files API and applies cleanly.
5. A resumed session after an owner comment costs measurably less than a cold run.
6. The `budget` cap stops a deliberately looping session.

If any fail → Cloud Run Job runner (ARCHITECTURE §2.4) is primary.

## Consequences

- The factory GCP project shrinks to: control/state buckets, KMS, WIF, Secret Manager, plus per-product dev projects for previews.
- The dispatcher waits on the session from GitHub Actions. That's free on public repos; private repos may later move the wait into a Cloudflare Worker cron or a Cloud Run job to save Actions minutes.
- Beta API: pin the beta header, keep the Cloud Run fallback tested in CI (smoke run weekly).
