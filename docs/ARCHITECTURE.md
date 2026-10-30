# globalhost — Architecture

> Status: draft for approval (2026-10-27). Decisions referenced as ADR-NNNN live in `docs/decisions/`.

globalhost is a personal software factory. AI agents plan, build, preview, and maintain software; the owner (one human, GitHub `anlinguist`) supplies direction, taste, and approval. **GitHub is the control plane**: everything the factory does is a GitHub operation, and everything the owner does can be done in GitHub directly.

## 1. Principles

1. **GitHub is the source of truth.** Issues = queue, labels = state, comments = steering, PRs = output. The factory keeps no state that can't be rebuilt from GitHub + Pulumi state + run artifacts.
2. **Merging is the only path to prod.** No agent identity can deploy to prod. Prod credentials are bound (via Workload Identity Federation conditions) to a release workflow running on the default branch.
3. **Builder ≠ grader.** The run that writes code never approves it. Reviewer runs are fresh, with a clean checkout of the exact head SHA and read-only credentials.
4. **Agents hold no write credentials.** The agent process gets an Anthropic key and a read-only checkout. A *trusted harness* (code we wrote, not influenced by model output) turns the agent's output into a branch + PR after policy checks.
5. **Profiles, not special cases.** The core knows about parts, profiles, adapters, and autonomy levels — never about Next.js, manifests, or OpenAPI.
6. **Rigid kernel, fluid stack** (ADR-0010). The factory enforces only the loop, trust, credentials, budgets and audit. Stack choices belong to each product and can change at any time; vendors plug in as integrations (MCP + IaC + scoped secrets). Agents act freely in dev; prod changes need a merge or an owner-approved `ops:` request. The end-to-end flow is in `docs/SDLC.md`.
7. **Cheap by default.** Target: ≤ $25/mo GCP, Anthropic spend within the Max plan's monthly API credit (ADR-0004), free GitHub (ADR-0006), free Cloudflare.

## 2. Components

```
                         ┌────────────────────────────────────────────────────┐
  Owner (phone/laptop)   │ GitHub (control plane)                             │
  ─ GitHub UI/mobile ───▶│  product repos: issues, labels, PRs, comments       │
  ─ Factory PWA (P3) ───▶│  .github/workflows/globalhost.yml  (installed)     │
                         │  GitHub App "globalhost-ai" (bot identity)         │
                         └──────────────┬─────────────────────────────────────┘
                                        │ issues/labeled, issue_comment, PR events
                                        ▼
                         ┌────────────────────────────────────────────────────┐
                         │ Dispatcher (GitHub Actions job in product repo)    │
                         │  • trust gate: sender.id ∈ owners, label allowlist │
                         │  • kill switch / budget check                      │
                         │  • WIF → GCP as sa:gh-dispatch (control, runs,     │
                         │    App key); GitHub OIDC → Anthropic (ADR-0014)    │
                         │  • create Managed Agents session, wait             │
                         │  • Publisher: validate bundle → push factory/* →   │
                         │    open/update PR (App token)                      │
                         └───────┬──────────────────────────────┬─────────────┘
                                 ▼                              ▼
  Claude Managed Agents  ┌──────────────────────────┐  GCP project globalhost-factory
  (ADR-0011)             │ one session per run      │  ┌──────────────────────────────┐
                         │  sandbox, limited egress │  │ gs://globalhost-control      │
                         │  roles: planner | builder│  │ gs://globalhost-runs (30 d)  │
                         │   | reviewer | ...       │  │ secret github-app-key        │
                         │  output: bundle +        │  │ budget → Pub/Sub → pause fn  │
                         │  run.json (Files API)    │  │ WIF pool github              │
                         └──────────────────────────┘  └──────────────────────────────┘
  Fallback, not built: Cloud Run Job runner with sa:runner (§2.4).
  CI (GitHub Actions, per profile): typecheck/lint/test, profile verify, guardrails
  Preview (per profile): Cloud Run tagged revision in <product>-dev project
        └─ Cloudflare Worker router + Access on *.globalhost.ai (ADR-0007)
  Release (per profile, deploy adapter): runs on push to main with sa:<product>-release
  Watchers (scheduled Actions in globalhost repo): store review status, orphan cleanup, budgets
```

### 2.1 The factory repo (`anlinguist/globalhost`)

pnpm + Turborepo monorepo:

| Path | Contents |
|---|---|
| `packages/core` | `factory.yaml` parser + schema (zod) + validator against an injected profile/adapter registry, label state machine, trust policy, path policy, budget accounting, Profile/DeployAdapter interfaces |
| `packages/cli` | `globalhost` CLI: `assess`, `install`, `validate`, `run` (local), `pause`/`resume`, `budget`, `preview`, `cleanup` |
| `packages/runner` | Harness + container image for Cloud Run Jobs |
| `packages/roles` | Role prompts + tool policies (planner, builder, reviewer, triager, …) |
| `packages/profiles/*` | `web-app`, `chrome-extension`, `service` (see PROFILES.md) |
| `packages/adapters/*` | Deploy adapters (`cloud-run`, `cloud-build-trigger`, `chrome-web-store`, …) |
| `packages/sanitize` | Untrusted-input sanitizer (vendored from gp-foundry, MIT; ADR-0001) |
| `skills/` | Shared Claude skills mounted into runs |
| `templates/` | Files rendered into product repos by `install` (workflows, CLAUDE.md, labels, Renovate) |
| `infra/` | Pulumi program for the factory itself + reusable Pulumi components (`@globalhost/pulumi-*`) |
| `projects/` | Multi-repo project manifests (ONBOARDING.md §6) |
| `evals/` | Reference tasks + metrics (Phase 6) |

### 2.2 Product repos

Each declares `factory.yaml` (contract in FACTORY-YAML.md; example in ONBOARDING.md §4). New products use the template (pnpm workspaces + Turborepo, `apps/*`, `packages/*`, `infra/`). Adopted repos keep their structure; `factory.yaml` maps parts to paths.

### 2.3 Dispatcher + Publisher (GitHub Actions, installed per repo)

A single small workflow `.github/workflows/globalhost.yml` rendered by `globalhost install`. It contains no logic beyond invoking pinned steps; logic lives in the runner image and in a pinned composite action from the factory repo (or vendored copy for repos that can't reach it — see ADR-0006).

Responsibilities:
1. **Trust gate.** Proceed only if `github.event.sender.id ∈ factory.yaml:owners[].id` (immutable user IDs; logins can be renamed and re-registered, ADR-0013), with `factory.yaml` read from the default branch, *and* the event is an allowlisted label or an owner comment on a `factory/*` PR. Never interpolate `${{ github.event.* }}` text into shell (zizmor/actionlint enforced in CI).
2. **Kill switch + budget.** Read `gs://globalhost-control/state.json` (`paused`, daily/monthly spend). Abort with a comment if paused or over budget.
3. **Concurrency.** `concurrency: globalhost-${repo}-${issue}`; plus a per-repo builder cap via a GCS lock object (generation-match precondition = compare-and-swap).
4. **Execute** the run: create a Managed Agents session with `{repo, ref, issue|pr, role, runId}` (Anthropic auth with the job's own GitHub OIDC token, ADR-0014) and wait; archive outputs to `gs://globalhost-runs/` as `sa:gh-dispatch`. With the unbuilt Cloud Run fallback, this step would execute the runner job instead.
5. **Publish** (trusted): download `bundle` + `run.json`, apply **path policy** (e.g. `.github/**` and `factory.yaml` are immutable to agents; profile guardrail paths add labels), push to `factory/issue-<n>` (never force, never the default branch), open/update a draft PR from the template, set labels, post the run report (cost, duration, tests written, files touched).

Phase 2+ may move steps 4–5 into a Cloud Run "publisher" job to save Actions minutes on private repos (public repos have unlimited minutes).

### 2.4 Runner

> **Primary host: Claude Managed Agents** (ADR-0011, accepted after spike P1-00): hosted sandbox with Node/pnpm/Chromium, server-side per-session budget, `limited` egress, vault secrets substituted at egress, resumable sessions, funded by the Max credit. Same contract as below: read-only inputs in, bundle + `run.json` out, trusted publisher pushes. The Cloud Run Job described below is the fallback host behind the same `RunnerHost` interface.

#### Fallback: Cloud Run Job

Container: Node 24, pnpm, git, `gh` (unused by agent), pinned `@anthropic-ai/claude-code` + `@anthropic-ai/claude-agent-sdk`, Playwright (separate image tag for profiles that need browsers), Entire CLI for session capture (ADR-0009).

Harness steps:
1. Fetch inputs: issue/PR content via GitHub API using a **read-only** App installation token passed by the dispatcher (contents:read, issues:read, pull_requests:read), scoped to one repo, expiring in ≤1h.
2. Clone at the given ref with no credentials persisted (`.git/config` has no token).
3. Build the prompt: role instructions + profile skill + product memory (`docs/product/*`) + **trust-tagged** inputs (§4).
4. Run the agent with: per-role tool allowlist, `disallowedTools` for `git push`, network allowlist (Anthropic, package registries) via Claude Code sandbox settings, `maxTurns`, wall-clock timeout (job task timeout), and a **per-run dollar cap** enforced by the harness from streaming usage (abort on exceed).
5. Run the profile's local checks (fast subset of verify) and record results.
6. Emit `bundle` (git bundle of new commits on top of base SHA), `run.json` (role, model, tokens, $ cost, duration, tests added, summary, questions for owner), and the Entire checkpoint export to `gs://globalhost-runs/<repo>/<runId>/`.

The runner SA reads no secrets: it authenticates to Anthropic with its own Google identity token through WIF (ADR-0014), and it can write to its run prefix. It has **no** GitHub write token, no deploy rights, no access to any product project.

> Residual risk: Cloud Run exposes the runner SA token on the metadata server to any process in the container, including the agent. This is why the runner SA is near-powerless; the most valuable thing in reach is minting ~10-minute Anthropic tokens while the job runs, capped by the Console workspace spend limit (ADR-0004, ADR-0014).

### 2.5 Roles

| Role | Trigger | Output | Writes code? |
|---|---|---|---|
| planner | label `factory:plan` (or new owner issue at L2+) | plan comment: approach, acceptance-test list, risks, wireframe options (UI), estimated cost | no |
| builder | label `factory:build`; owner comment on `factory/*` PR | bundle → branch + PR | yes |
| reviewer (P2) | PR opened/updated by builder | PR review (comment/request-changes) with structured findings vs. spec | no |
| triager (P5) | scanner finding / Sentry issue | label + classification comment | no |
| fixer (P4) | `factory:autofix` (from triage/Sentry) | draft PR with regression test | yes |
| assessor | `globalhost assess` | onboarding issue | no |

Patterns borrowed (ADR-0001): label contract + handoff comment, fail-closed gate script, cold verifier with revert-the-fix proof, structured `REVIEW.json`.

### 2.6 Previews

Defined by each profile's preview contract (PROFILES.md §2). Hosted parts deploy as a **tagged, no-traffic Cloud Run revision** (`pr-<n>`) of a single `<part>-preview` service in the product's **dev project**, with:
- an `access-guard` ingress sidecar that rejects requests without a valid Cloudflare Access JWT, so the `*.run.app` URL is not a bypass;
- dev/seed data only (never prod data, never prod credentials);
- `min-instances=0`, `max-instances=1`.

Routing: Cloudflare Worker on `*.globalhost.ai` maps `<product>-<part>-pr-<n>.globalhost.ai` → the tagged revision URL, behind one Cloudflare Access application (owner email only). Infra-changing PRs get a full Pulumi review stack `pr-<n>` instead. ADR-0007.

### 2.7 Release

Each part's profile names a **deploy adapter** (PROFILES.md §3). Release runs in a workflow on push to the default branch, authenticated as `sa:<product>-release`, whose WIF binding requires `ref == refs/heads/<default>` and `workflow == release.yml`. Adopted repos keep their existing deploy (e.g. numu-know's Cloud Build triggers) via the `cloud-build-trigger` adapter, which only *observes* and reports.

Async gates (Chrome Web Store review, App Store review) are tracked by a scheduled watcher that polls adapter `status()` and comments/notifies on change.

## 3. Data flow: the loop

```
owner files issue ──▶ label factory:plan ──▶ planner run ──▶ plan comment
        ▲                                                       │
        │ redirect (comment)                    owner applies factory:build
        │                                                       ▼
        │                              builder run ──▶ bundle ──▶ publisher
        │                                                       │
        │                                       branch factory/issue-n + draft PR
        │                                                       ▼
        │                       CI (verify + guardrails) ─▶ preview deploy ─▶ PR comment
        │                                         (P2) reviewer run ─▶ review
        │                                                       ▼
        └────────── owner comment on PR (re-runs builder) ◀── taste gate
                                                                │ owner merges
                                                                ▼
                                         release.yml ─▶ deploy adapter ─▶ status on PR/issue
```

### Label state machine

| Label | Meaning | Set by |
|---|---|---|
| `factory:plan` | owner requests a plan | owner |
| `factory:planned` | plan posted, awaiting owner | publisher |
| `factory:build` | owner approves build | owner |
| `factory:building` | run in progress (claim) | dispatcher |
| `factory:in-review` | PR open, awaiting CI/review/owner | publisher |
| `factory:blocked` | agent needs an answer; question in comment | publisher |
| `factory:failed` | run failed or hit a cap | publisher |
| `needs:owner-approval` | a guardrail tripped (permissions, breaking API, immutable path) | CI guardrail check |
| `approved:<guardrail>` | owner acknowledges a specific guardrail | owner |
| `factory:autofix` | (P4) eligible for auto-fix run | triager |
| `factory:paused` | per-repo pause | owner |

Only `factory:plan`, `factory:build`, and `approved:*` start or unblock work, and only when applied by an owner. The branch claim (`factory/issue-<n>` first non-force push wins) prevents duplicate builders.

## 4. Trust boundaries & prompt-injection defense

| Zone | Examples | Treatment |
|---|---|---|
| **Trusted** | owner-authored issues/comments; `factory.yaml`, `CLAUDE.md`, `docs/product/*` on the default branch; factory repo code | instructions |
| **Untrusted** | issues/comments by anyone else; PR descriptions by others; Sentry payloads; scanner output; dependency READMEs; web pages; CI logs; anything in a PR branch the agent itself wrote | data only |

Rules:
1. **Triggering:** only owner actions start runs. On public repos, issues/comments from others never trigger; they can be pulled in only when the owner labels them, and even then their text is untrusted.
2. **Framing:** untrusted text passes through `packages/sanitize` (strip control/bidi/zero-width chars, cap length, mask secrets) and is fenced in a `<untrusted source="…">` block with a standing instruction that it is data.
3. **Capability limits beat prompt hygiene:** even a fully hijacked agent can only (a) spend up to the run cap and (b) produce a bundle that the publisher pushes to a `factory/*` branch as a draft PR, subject to path policy. It cannot merge, deploy to prod, touch workflows, read prod data, or change `factory.yaml`.
4. **Network:** agent egress limited to an allowlist (Anthropic API, npm/pnpm registry, GitHub read for clone) using Claude Code sandbox network rules. Arbitrary `WebFetch` disabled for builders; planners may fetch from an allowlisted docs list.
5. **Dependencies:** lockfiles required; new direct dependencies trip `needs:owner-approval` (`approved:deps`). Runner image and Actions pinned by digest/SHA.
6. **Workflow hardening:** zizmor + actionlint + gitleaks (full history) in CI, tools pinned by SHA-256; no `pull_request_target` with checkout of PR head; minimal `permissions:` per job; no caches saved from PR runs; GitHub secret scanning + push protection on public repos.

## 5. Credential & permission model

### 5.1 Identities

| Identity | Where | Can | Cannot |
|---|---|---|---|
| Owner (`anlinguist`) | GitHub, GCP, Cloudflare | everything | — |
| GitHub App `globalhost-ai` | installed per repo | contents RW, issues RW, PRs RW, checks R, actions R, metadata R | **workflows** (cannot modify `.github/workflows/**`), administration, secrets, members |
| App token (read-only variant) | minted by dispatcher for the run's inputs | contents/issues/PRs read on one repo, 1h | any write |
| `sa:gh-dispatch` (`globalhost-gh-dispatch`) | WIF provider `github/globalhost-dispatch`: owner ID 47403803, a listed repo ID on its default branch, environment `globalhost` (product repos' `globalhost.yml`) | bucket- and secret-level only: read/write/delete objects in `globalhost-control`; create + read objects in `globalhost-runs`; access secret `github-app-key` | any project-level role; overwrite or delete run artifacts; deploy anything; read product projects |
| `sa:runner` (**not built**; Cloud Run fallback only) | Cloud Run Job | would: write `gs://globalhost-runs/<run>`; its identity token accepted by one Anthropic federation rule (ADR-0014) | read any secret; anything else |
| `sa:globalhost-budget-pause` | Cloud Function `globalhost-budget-pause` (runtime and Pub/Sub trigger identity) | read/write `gs://globalhost-control/state.json` only (IAM condition); invoke its own function | anything else |
| `sa:globalhost-fn-build` | Cloud Build for that function | write logs; push to Artifact Registry `globalhost-functions`; read the function source bucket | anything else |
| `sa:globalhost-local` | impersonated by the owner for `globalhost run` | mint its own Google identity token, which one Anthropic federation rule accepts (ADR-0014) | any GCP role; anything else |
| `sa:globalhost-spike` (temporary, P1-00) | impersonated by the owner locally | mint its own Google identity token, which one Anthropic federation rule accepts (ADR-0014); deleted when the spike ends | any GCP role; anything else |
| `sa:<product>-preview` | WIF from product repo, PR workflows only | deploy `<part>-preview` revisions + push images in `<product>-dev`; read dev secrets | touch prod project |
| `sa:<product>-release` | WIF, `ref=refs/heads/<default>` + `workflow=release.yml` only | deploy prod per adapter | be impersonated from PRs or other workflows |
| Cloudflare API token (preview) | dev secret | edit Worker KV / routes on `globalhost.ai` zone | other zones |
| `sa:globalhost-auditor` (ADR-0012) | WIF, factory repo `main`, environment `security-audit` only | list/read/create objects in the audit report bucket | read any secret; delete or overwrite reports; any GitHub write; anything else |
| `sa:globalhost-audit-publisher` (ADR-0012) | WIF, factory repo `main`, environment `security-audit-publish` only (job runs no repo code) | read audit reports; read `globalhost-ops-issues-token` (Issues RW on `globalhost-ops` only) | write reports; any other repo |

No long-lived GCP keys anywhere. The GitHub App private key lives in Secret Manager in `globalhost-factory` (`github-app-key`, readable only by `sa:gh-dispatch`). There is no Anthropic key (ADR-0014). Product secrets live in the product's own projects (dev and prod separated), set via `pulumi config set --secret` or `gcloud secrets versions add` by the owner — never by agents.

### 5.2 GCP project layout

No GCP Organization exists (projects are under the personal account). Layout:

| Project | Purpose | Billing budget |
|---|---|---|
| `globalhost-factory` (new) | run artifacts, control bucket, Pulumi state bucket + KMS, WIF pool, factory secrets, budget-pause function (`infra/factory`). No runner job or runner image (ADR-0011) | part of $25/mo factory budget |
| `<product>-dev` (new per product as needed, e.g. `numu-know-dev`) | preview services, dev Firestore/DB, seed data | part of $25/mo factory budget |
| existing prod projects (`numu-know`, `biblia-sacra`, `reader-365202`, …) | unchanged prod | existing |

Budget alerts at 40/80/100% of $25 on the factory+dev projects; the 100% alert publishes to Pub/Sub → a tiny function sets `paused=true` in the control bucket (GCP budgets alert but don't cap by themselves).

### 5.3 Branch protection without paid GitHub

See ADR-0006. Public repos get rulesets on free (require PR, require checks, block force-push, restrict who can push to default). Private repos on a free personal account don't enforce protection, so the guarantees there come from: the App lacking workflow permission, the publisher only ever pushing `factory/*`, and release credentials bound to the default branch + release workflow. The owner remains the only actor who merges.

## 6. Cost controls

| Control | Mechanism | Phase |
|---|---|---|
| Per-run cap | harness aborts at `$X` (default $4) or `maxTurns` / job timeout (default 45m) | 1 |
| Hard monthly cap | Anthropic Console workspace spend limit = monthly credit | 1 |
| Daily budget | dispatcher sums `run.json` costs in control bucket; default $20/day | 1 (simple) / 2 |
| Kill switch | `globalhost pause` sets `paused=true`; dispatcher refuses; running jobs cancelled | 1 (minimal) / 2 |
| GCP | budget alerts + auto-pause; lifecycle rules on every bucket; AR cleanup policy on the function image repo; scale-to-zero everywhere | 1 |
| Orphans | nightly cleanup of preview tags/images/review stacks whose PR is closed | 1 (tags) / 2 (stacks) |
| Auto-fix cap | ≤ N auto-fix runs/day, never auto-merge | 4 |

## 7. Observability of the factory itself

Every run writes `run.json`; a nightly job aggregates into `gs://globalhost-control/metrics/` and the factory repo's `docs/metrics.md` (merge rate, redirects/PR, cost per merged PR, time to PR). Entire checkpoints link each commit to its agent session for later audit (ADR-0009).

## 8. What's deliberately not here (yet)

- A long-running orchestrator server. Phase 1–2 are event-driven via Actions; Phase 3's PWA backend is the first server (Cloudflare Workers; ADR-0003).
- A database. State = GitHub + GCS objects.
- Merge queue (unavailable on free personal accounts; ADR-0006). The serializing "ship" action (rebase-onto-main, wait green, merge) covers solo-volume needs.
