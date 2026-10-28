# globalhost — Onboarding (adopt a repo)

> Status: draft for approval (2026-10-27).

Adopting an existing repo is a first-class workflow: `globalhost adopt <owner/repo>`. It must **never break the repo's existing CI or deploy**.

## 1. Stages

### Stage 1 — Assessment (read-only, L0)

`globalhost assess <repo>` runs the assessor role in a runner with a read-only token. It never pushes. Output: an **onboarding issue** in the repo (or in the factory repo for private/unsure cases) containing:

| Section | Contents |
|---|---|
| Stack & parts | detected parts with profile + confidence + evidence (`detect()` from each profile) |
| Branches & flow | default branch, long-lived branches (e.g. `develop`/`staging`), which branch deploys where |
| Current CI/deploy | GitHub workflows, Cloud Build triggers (`gcloud builds triggers list`), Cloud Run services, Firebase hosting, store listings |
| Tests | frameworks, test count, coverage if measurable, does `build` pass from clean checkout |
| Secrets | `gitleaks` over full history + `git ls-files` for credential-shaped files; for GCP SA key files, checks whether the key ID is **still active**. Findings list *rotation* steps, not just removal |
| Data | DBs/datastores used, whether a dev/staging dataset exists separate from prod |
| Visibility & people | public/private, collaborators, outside contributors (affects trigger policy) |
| Agent-readiness score | 0–100, rubric below |
| Proposed `factory.yaml` | parts, profiles, adapters (existing deploy kept), autonomy `L1` |
| Multi-repo | if part of a project, proposed consolidation or managed multi-repo (§6) |
| Risks & asks | things the owner must decide |

**Agent-readiness rubric (100):** builds from clean checkout (15) · typecheck/lint configured (10) · automated tests exist (15) · tests cover critical paths (15) · reproducible local dev / seed data (10) · non-prod environment separate from prod data (15) · docs/CLAUDE.md (5) · no live secrets in repo/history (10) · CI exists (5).

### Stage 2 — Install PR (owner reviews closely)

Prepared by the owner running `globalhost install` locally (the App deliberately lacks `workflows` permission, so workflow files are committed under the owner's identity). Contents:

- `factory.yaml` (autonomy `L1`)
- `CLAUDE.md` (repo conventions, commands, do/don't)
- labels (§3 of ARCHITECTURE.md)
- `.github/workflows/globalhost.yml` (dispatcher) and `globalhost-ci.yml` (core + profile verify) — **added alongside** existing workflows, never replacing them
- `CODEOWNERS` (`* @anlinguist`)
- rulesets/branch protection (public repos; ADR-0006), secret scanning + push protection, CodeQL, Dependabot alerts, Renovate config
- `docs/product/SPEC.md`, `DESIGN.md`, `DECISIONS.md` reverse-engineered from code — **these become the taste baseline**; the owner edits them in review

### Stage 3 — Safety nets (before feature work)

- Characterization tests pinning current behavior of critical paths (Playwright smoke + screenshots for web; request/response snapshots for APIs; extension smoke on target sites).
- Dev environment + seed data so previews never touch real user data.
- Sentry + OpenTelemetry (Phase 4 if not trivially available).

### Stage 4 — Infra

Keep the existing deploy via a deploy adapter. Migrating to Pulumi (`pulumi import`) is a separate, optional issue proposed only when it pays for itself (e.g. needing canary/rollback, or review stacks).

### Secrets found in history

Rotate first (new key/credential, update consumers, disable old, verify, delete old), then optionally purge history. Purging is never a substitute for rotation.

## 2. Autonomy levels

| Level | Agent may | Promotion criteria (to next) |
|---|---|---|
| **L0 observe** | run scans, open issues/comments | owner approves install PR |
| **L1 on request** | plan/build only on owner-filed issues with an owner-applied label | CI green on default branch; characterization tests for critical paths; working preview; ≥5 factory PRs merged with ≤1 redirect avg |
| **L2 full loop** | planner auto-runs on new owner issues; reviewer gates; builder runs after plan approval; owner gate before merge | ≥20 merged factory PRs; 0 rollbacks/incidents caused in 30 days; visual/contract baselines established |
| **L3 trusted** | auto-merge for categories listed in `autoMerge` (e.g. Renovate patch, lint fixes) when CI + reviewer pass | — |

Never at any level: auto-merge of guardrail-tripping changes (`manifest-permissions`, `openapi-breaking`, migrations, new deps), auto-fix PRs, or anything touching auth/payments paths listed as `loadBearing`. Demotion is immediate on any incident.

## 3. Trigger policy (public repos)

Only labels/comments from `owners` start work. Issues from others can enter the loop only after the owner labels them, and their text is always untrusted data. The dispatcher checks `sender.login`, not issue author, so a stranger's issue labeled by the owner is processed with the stranger's text fenced as untrusted.

## 4. `factory.yaml` schema

```yaml
# factory.yaml — validated by `globalhost validate` (JSON Schema generated from packages/core)
version: 1
product: numu-know                # unique slug; used in preview hostnames and GCP naming
owners: [anlinguist]              # GitHub logins whose actions are trusted
autonomy: L1                      # L0 | L1 | L2 | L3
project: null                     # or a project id from globalhost/projects/*.yaml

git:
  defaultBranch: main
  baseBranch: main                # where factory PRs target
  branchPrefix: factory/

environments:
  dev:  { gcpProject: numu-know-dev, region: us-central1 }
  prod: { gcpProject: numu-know,     region: us-central1 }

parts:
  web:
    path: .                       # repo root for single-app repos
    profile: web-app
    config:
      port: 8080
      routes: ["/", "/stories", "/dictionary", "/learn"]
      previewEnv: { NEXT_PUBLIC_FIREBASE_PROJECT_ID: numu-know-dev }
      seed: "pnpm seed:dev"
    preview: { enabled: true }
    release:
      - adapter: cloud-build-trigger
        config: { project: numu-know, trigger: "<trigger-name>" }
    dependsOn: []

limits:
  maxConcurrentBuilders: 1
  perRunUsd: 4
  perRunMinutes: 45
  dailyUsd: 20                    # per repo; global cap lives in factory config

guardrails:
  loadBearing: ["app/api/**", "proxy.ts", "lib/firebase*"]   # always needs:owner-approval
  immutable: [".github/**", "factory.yaml"]                    # agents can never change

autoMerge: []                     # L3 only, e.g. ["renovate:patch"]

notifications:
  blocking: push                  # push | digest | none
  previews: digest
  routine: digest
```

Schema rules: `product` matches `^[a-z][a-z0-9-]{1,30}$`; each part's `config` validated by its profile's `configSchema`; adapter `config` by the adapter's schema; `dependsOn` must be acyclic; bindings may only reference declared outputs.

## 5. Factory-level config

`globalhost/config/factory.yaml` (in the factory repo): global daily/monthly caps, owner identities, notification channels, default models per role, allowlisted network domains, and the list of installed repos.

## 6. Multi-repo projects

### 6.1 Default: consolidate

The assessment proposes merging a project's repos into one monorepo (`apps/<part>`) when there's no strong reason to keep them apart. Method: `git filter-repo --to-subdirectory-filter apps/<part>` per repo, then merge with `--allow-unrelated-histories` into the new monorepo — full history and blame preserved.

### 6.2 Fallback: managed multi-repo

Used when there's a real reason (public/private split, different collaborators, different release cadence). Manifest in the factory repo:

```yaml
# globalhost/projects/<id>.yaml
version: 1
project: readefine
owners: [anlinguist]
repos:
  server:    { repo: readefine-app/readefineserver,     parts: { api: { profile: service } } }
  webapp:    { repo: readefine-app/readefinewebapp,     parts: { web: { profile: web-app } } }
  extension: { repo: readefine-app/readefineextension,  parts: { extension: { profile: chrome-extension } } }
dependencies:
  - { consumer: webapp.web,          provider: server.api, contract: openapi }
  - { consumer: extension.extension, provider: server.api, contract: openapi }
mergeOrder: [server, webapp, extension]    # providers first
```

Behavior:
- Runner checks out all repos into one workspace (`/work/<key>`), so the agent sees the whole system.
- One **parent issue** (in the provider repo or factory repo) with child PRs per repo, all on branch `factory/<project>-<n>`.
- Composite previews resolve bindings across repos using matching branch names (falling back to the dev deployment for repos without the branch).
- Provider changes must be backward-compatible (expand/contract) and pass consumer contract tests; merges happen in `mergeOrder`.
- The factory presents the PR group as one approval; "ship" merges in order, waiting for each provider release to go healthy.

## 7. Readefine consolidation plan (first candidate)

**Scope:** server, web, webhooks, extension (Chrome, Edge, Firefox and Safari from one source tree), plus the marketing site. Live-environment facts (projects, deploy map, open items) are in the private `globalhost-ops` repo (`products/readefine.md`), per §8.

**Plan (each step an issue; nothing starts until Phase 2 and owner approval):**

1. **Assess** the remaining repos (L0). Inventory every deploy path (Cloud Build triggers, manual `gcloud` deploys, store uploads), every secret (incl. history), and every store identity (CWS item ID, `key`, Firefox gecko ID, Safari bundle ID, Edge product ID).
2. **Parity baseline:** record current build outputs (extension zips per target with content hashes, container image digests) and deploy procedures.
3. **Freeze** feature work on those repos (announce in each repo README; disable factory runs).
4. **Merge** into `readefine-app/readefine` with `git filter-repo` → `apps/server`, `apps/web`, `apps/webhooks`, `apps/extension`. pnpm workspaces + Turborepo, but each app keeps its own build scripts initially.
5. **Path-filtered CI** per app (`paths:` filters / turbo `--filter`), existing tests running unchanged.
6. **Deploy parity via adapters:** repoint Cloud Build triggers to the monorepo with `includedFiles`/`dir` per app (or `cloud-run-existing`); extension release stays on the **same CWS item ID, same developer account, same `key`**, so existing users get a normal update. Verify the new build's zip contents match the baseline except for intended differences.
7. **Verify one release of each part** from the monorepo (server, web, webhooks, extension to trusted testers then staged rollout).
8. **Archive** the old repos read-only with a README pointing to the monorepo. Never delete.
9. **Unfreeze**; onboard the monorepo at L1 with composite previews (extension build bound to the PR's API URL).

## 8. Known onboarding findings

Kept in the private repo `anlinguist/globalhost-ops` (`open-findings.md`, `runbooks/`), not here: this repo is public, and unfixed findings, credential details, and bypasses must not be published. The factory's assessor (P1-08) files findings for a product in that product's own repo, never in this one.
