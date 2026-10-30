# ADR-0011: Runner host — Claude Managed Agents first, Cloud Run Job as fallback

- Status: accepted 2026-10-29 after spike P1-00 (results below). Criterion 1 still awaits the owner's Console billing check.
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
- **Same credential rule as before.** The repo goes into the session as a **git bundle through the Files API**, which the spike proved works. The session holds no GitHub credential and has no GitHub egress. (`github_repository` with a read-only token, which a git proxy injects outside the sandbox, is the alternative if bundles get too large.) The agent writes a git bundle + `run.json` to `/mnt/session/outputs/`. The trusted publisher fetches them via the Files API and pushes to `factory/*`. Dev-integration secrets go in vaults (egress-injected). No prod secrets ever go in a vault an agent session can use.
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

## Spike P1-00 results (2026-10-29)

**Setup:** numu-know#10 ("CSP blocks audio"), on `claude-opus-5-5` with default effort. Networking was `limited` with package managers only, web tools off, and permission policy `always_allow`. The repo was uploaded as a git bundle. Auth was keyless (ADR-0014). Code is in `spikes/managed-agents/`.

| # | Criterion | Result | Numbers |
|---|---|---|---|
| 1 | Session runtime and tokens draw on the monthly credit | **Pending (owner)** | Check the Console usage and billing pages for `globalhost-runners` on 2026-10-29. Total list cost across the four sessions was about $2.35, including session runtime at $0.08/h. |
| 2 | Install, build and test in the sandbox in under 15 min | **Pass** | `npm ci --legacy-peer-deps` 43 s, `next build` 24 s, Playwright install 3 s (preinstalled Chromium 1194 matched `@playwright/test` 1.56.1), smoke test 9 s |
| 3 | `limited` networking blocks hosts not on the allowlist | **Pass** | `example.com`: DNS failed (curl exit 6). `registry.npmjs.org`: 200. |
| 4 | Bundle round-trips through the Files API and applies cleanly | **Pass** | Repo in (900 KB bundle) and fix out (1 commit, `proxy.ts` +2). `git bundle verify` and a fetch onto base `d9520f9` succeeded. |
| 5 | Resuming after an owner comment costs less than a cold run | **Inconclusive** | Resume delta $0.40 in 207 s, versus cold run $0.43 in 306 s: 7% cheaper, 32% faster. Too small a task to show context savings. Re-measure on a larger task in P1-14. |
| 6 | The `budget` cap stops a looping session | **Pass** | A $1.00 cap went idle with `budget_reached` at $1.00 reported list cost, after about 300 tool calls. |

**Typical cost:** a small real fix ran $0.43–0.51 and 5–6 minutes per session.

**Findings the harness and profiles must handle:**
- **The SSE stream can drop while a session keeps running.** The loop session's stream ended after about 6 minutes, with no idle event. The dispatcher must reconnect, and must reconcile through `events.list` or `sessions.retrieve` before deciding a run is over.
- **Agents adapt to repo quirks, and the profile should know them up front.** The agent found that numu-know needs `npm ci --legacy-peer-deps` (a React 19 peer conflict; the repo's Dockerfile already uses the flag). It also found that the app returns 500 without the build-time `NEXT_PUBLIC_FIREBASE_*` config. So previews and smoke tests need dev Firebase config (P1-10).
- **Agents verify beyond the brief.** When the specified smoke test couldn't reach its assertion, the agent built a control: the fix passed and unmodified `main` failed with the exact error from the issue. It reported its own test as failed instead of claiming success.
- **The bundle needs a usable HEAD.** A bundle of `main` alone left HEAD pointing at a missing `master`, and the agent recovered. The harness should create bundles with `--all` or set HEAD explicitly.

**Decision:** go. Managed Agents is the primary runner, and the Cloud Run Job stays a documented fallback, built only if a later requirement fails (PLAN P1-04 and P1-06 are adjusted).

## Consequences

- The factory GCP project shrinks to: control/state buckets, KMS, WIF, Secret Manager, plus per-product dev projects for previews.
- The dispatcher waits on the session from GitHub Actions. That's free on public repos; private repos may later move the wait into a Cloudflare Worker cron or a Cloud Run job to save Actions minutes.
- Beta API: pin the beta header, keep the Cloud Run fallback tested in CI (smoke run weekly).
