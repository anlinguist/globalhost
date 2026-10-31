# globalhost — The SDLC end to end

> Status: draft for approval (2026-10-27). The *kernel* (ADR-0010) enforces the gates below; everything else is product-specific and changeable.

## The loop at a glance

```
 SIGNALS                    SHAPE                 BUILD & PROVE                 SHIP                 RUN
 ───────                    ─────                 ─────────────                 ────                 ───
 you: idea (phone/issue) ┐                         ┌──────────── redirect ◀───────────┐
 Sentry error ───────────┤                         ▼                                  │
 security finding ───────┼─▶ ISSUE ─▶ PLAN ─▶ ◆A ─▶ BUILD ─▶ VERIFY ─▶ REVIEW ─▶ PREVIEW ─▶ ◆B ─▶ SHIP ─▶ RELEASE ─▶ OPERATE
 Renovate / deps ────────┤      (planner)   you    (builder) (CI +    (reviewer  (composite  you    (merge) (adapter,  (observe,
 analytics / feedback ───┤                         dev MCP    guard-   agent)     env, seed           canary,    alerts,
 scheduled sweeps ───────┘                         + IaC      rails)                  data)              stores)    autofix)
        ▲                                                                                                          │
        └───────────────────────────────── new signals ◀───────────────────────────────────────────────────────────┘
 LEARN (continuous): redirects → product memory + skills; run metrics → evals; track record → autonomy level
```

◆A = **intent gate** (approve the plan). ◆B = **taste gate** (approve the result). Below L3 both are yours. At L3 (ADR-0015) ◆B is optional: a reviewer and a deterministic merge policy ship owner-originated work, and you're pulled in only by escalation triggers, or whenever you choose to look.

## Stage by stage

| # | Stage | Trigger (GitHub op) | Who acts | What's produced | Your involvement |
|---|---|---|---|---|---|
| 0 | **Signal** | issue opened (by you, or by watchers: Sentry, scanners, Renovate) | you / watchers / triager | an issue; untrusted sources are labeled and fenced | file ideas in any form; a phone note is fine |
| 1 | **Shape** | label `factory:plan` (auto at L2+) | planner | plan comment: spec delta, acceptance tests, approach, risks, cost estimate; **UI**: 2–3 wireframe options rendered as screenshots; **API**: OpenAPI delta; **stack change**: options + migration/rollback plan | — |
| ◆A | **Intent gate** | you: `factory:build`, a redirect comment, or close | you | — | approve, pick a wireframe ("go with B, tighter spacing"), or redirect |
| 2 | **Build** | gate A label | builder (one run; fan-out to subagents in Phase 6) | acceptance tests first, then code, IaC/scripts. Product-memory updates go in their own PR (ADR-0015). May provision **dev** resources via integration MCP servers (ADR-0010) | none unless the agent asks (`factory:blocked` + question) |
| 3 | **Verify** | PR push | CI | core checks + profile verify (Playwright/visual, extension on target sites, contract tests/oasdiff) + guardrails | only if a guardrail trips (`needs:owner-approval`): permissions, breaking API, migrations, new deps, load-bearing paths |
| 4 | **Review** | CI green | reviewer (fresh run, read-only; judges from the diff, spec and CI artifacts; verifier on findings; ADR-0015) | function, security and performance verdicts; merge policy decides merge / builder fix loop (≤2 rounds) / escalate | only on escalation |
| 5 | **Preview** | CI green (in parallel with review) | profile preview contracts | composite environment for *this* PR (e.g. API pr-42 + web pr-42 + extension zip bound to it), seeded dev data, screenshots/GIF, API docs; listed in your daily digest (or pushed if urgent) | open on phone behind Access |
| ◆B | **Taste gate** | you (below L3, or escalated) | you | — | comment to redirect (→ back to 2; redirects feed product memory through separate PRs), or **ship**. At L3, optional |
| 6 | **Ship** | `factory:ship` / G.Host ship / you merge / merge policy (L3) | ship action | rebase, re-verify on latest main, merge (serialized per repo) | one tap |
| 7 | **Release** | push to default branch | release workflow + deploy adapter (prod creds live only here) | prod deploy: canary → full or auto-rollback; prod IaC/migrations applied (expand first); store uploads → trusted testers → staged rollout; async gates tracked | approve store promotions / staged-rollout increases if configured |
| 8 | **Operate** | continuous | watchers, fixer | Sentry/OTel/PostHog signals → deduped issues; auto-rollback on error spikes; auto-fix **draft** PRs with regression tests (re-enter at 3) | blocking alerts only |
| 9 | **Maintain** | schedules | Renovate, scanners, triager, janitor | dep updates (escalate to you; ADR-0015), security fixes/mitigations, orphan cleanup, budget reports, doc refresh | weekly digest |
| 10 | **Evolve stack** | an issue ("try Resend instead of Klaviyo") | planner → builder | stack-change plan → dev provisioning via MCP + code → preview → prod via merge / ops request | approve the plan; approve any `ops:` request |
| 11 | **Learn** | merges, redirects, metrics | factory | skills/memory PRs from redirect patterns, evals on prompt/skill changes, autonomy promotion/demotion proposals | approve learning PRs |
| 12 | **Retire** | issue `retire` | planner → you | data export, destroy stacks, store unlisting, archive repo with pointer README | approve |

Starting a new product is stages 0–1 at the portfolio level: an issue in the factory repo → planner proposes name, stack, profiles, cost → you approve → the factory creates the repo from the template, installs, provisions dev → normal loop from there. Adopting an existing repo is ONBOARDING.md, which lands the repo at stage 0 with L0/L1.

## Where each kind of change goes

| Change | Path to prod |
|---|---|
| App code, config, tests | PR → merge → release |
| Infra (GCP/Cloudflare/Neon/…) with an IaC provider | PR with IaC (review stack for risky diffs) → merge → release applies |
| Vendor setup without IaC (verify domain, toggle a setting) | dev: agent via MCP freely; prod: `ops:` request → `approved:ops` → trusted executor |
| Secrets | you set them (or the integration mints them in dev); agents only reference names |
| Data migrations | expand in PR N (backward compatible) → release → contract in PR N+1 |
| Extension permissions / breaking API / destructive migrations | always your explicit approval, at every autonomy level |

## Worked example: "switch numu-know's emails from Klaviyo to Resend"

1. You (phone): "Let's move new-story emails to Resend." → issue.
2. Planner: stack-change plan. Resend integration exists; new `lib/email` abstraction; React Email template; dev uses a Resend test domain; prod needs domain verification (DNS on Cloudflare) + API key; Klaviyo list sync stays until parity, then removed (expand/contract); cost: free tier. Two template mockups as screenshots.
3. You: "Go with mockup 2." (`factory:build`)
4. Builder: writes tests (template renders, send called on new story), implements, adds `infra/resend.ts` script, uses Resend MCP (dev key) to create the dev domain and send a test email to a sandbox inbox, then records what it did in `DECISIONS.md` and `STACK.md`.
5. CI + reviewer pass. The preview links to the rendered email + a screenshot of the delivered test email.
6. You: "Subject line is too long." → builder revises.
7. Ship → release workflow runs. Prod needs the DNS records + domain verification, which Cloudflare IaC handles. Resend domain verification has no IaC, so the agent posts `ops:` (exact Resend API calls); you tap approve; the executor runs it and posts the result.
8. Operate: PostHog/Resend logs read-only; a week later the planner opens the "contract" issue to remove Klaviyo.

## What the factory refuses to do, at any autonomy level

- Merge its own PRs below L3, or merge anything that came from untrusted input or trips an escalation trigger (ADR-0015).
- Deploy to prod or mutate prod vendors without a merge or an approved `ops:` request.
- Act on instructions from anyone but the owner.
- Exceed run, daily, or monthly budgets (it pauses and asks).
