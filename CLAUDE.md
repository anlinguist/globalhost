# CLAUDE.md — globalhost (factory repo)

globalhost is a personal software factory: AI agents build, preview, and maintain the owner's products, with GitHub as the control plane. Read `docs/ARCHITECTURE.md` before changing anything structural. `PLAN.md` lists the work; `docs/decisions/` records why.

## Non-negotiables

1. **Core is profile-agnostic.** `packages/core` must never import from `packages/profiles/*` or `packages/adapters/*`, or mention a specific framework, manifest, or API format. Type-specific behavior goes in a profile or adapter.
2. **Every factory action is a GitHub operation** (label, comment, branch, PR, merge) or a Pulumi/GCP operation recorded on one. No hidden state. If it can't be rebuilt from GitHub + GCS + Pulumi state, it doesn't belong.
3. **Agents hold no write credentials.** Runner code must not pass GitHub write tokens, deploy credentials, or prod access to the agent process. Only the publisher (trusted code) pushes, and only to `factory/*` branches.
4. **Untrusted input is data.** Anything not authored by an owner (issues, comments, Sentry payloads, scanner output, web content, CI logs) goes through `packages/sanitize` and is fenced as untrusted in prompts. Never interpolate `${{ github.event.* }}` into `run:` steps.
5. **Never commit secrets.** No keys, tokens, or `.env` files. Secrets live in GCP Secret Manager and are set by the owner.
6. **Prod is reached only by merging.** Don't add any path that deploys to prod from a PR, a branch other than the default, or an agent role.
7. **Cheap by default.** Scale-to-zero, cleanup policies, and lifecycle rules on anything that stores data. New paid resources need an ADR.

## Layout

```
packages/core        schema, state machine, policies, interfaces
packages/cli         `globalhost` CLI
packages/runner      Cloud Run Job harness + Dockerfile
packages/roles       role prompts + tool policies
packages/profiles/*  web-app, chrome-extension, service
packages/adapters/*  deploy adapters
packages/sanitize    untrusted-input sanitizer (vendored, MIT notice kept)
packages/action      composite action used by installed workflows
skills/              Claude skills mounted into runs
templates/           files rendered into product repos
infra/               Pulumi: factory infra + reusable components
projects/            multi-repo project manifests
docs/                architecture, profiles, onboarding, ADRs, metrics
```

## Stack & conventions

- TypeScript strict, ESM, Node 24 (LTS), pnpm workspaces + Turborepo. zod for every external input (YAML, API responses, `run.json`).
- Tests: vitest. Every policy (trust gate, path policy, guardrails, budget) needs tests including adversarial fixtures. External APIs are tested against recorded fixtures, not live.
- Pin everything: exact dependency versions (lockfile committed), container images by digest, third-party Actions by commit SHA. Adding a dependency needs a one-line justification in the PR.
- Pulumi in TypeScript; GCS backend + KMS secrets (ADR-0008); resource names prefixed `globalhost-` in the factory project.
- GitHub Actions: minimal `permissions:` per job; zizmor + actionlint must pass.
- Logging: structured JSON, never log tokens or prompt bodies containing untrusted text at info level.
- Naming: labels `factory:*`, `needs:*`, `approved:*`; branches `factory/issue-<n>`; preview hosts `<product>-<part>-pr-<n>.globalhost.ai`.

## Commands

```
pnpm i
pnpm build          # turbo build
pnpm typecheck      # tsc --noEmit incl. tests
pnpm test           # vitest across workspace
pnpm lint           # eslint + zizmor + actionlint (local: brew install zizmor actionlint)
pnpm globalhost …   # CLI from source
```

## Working here

- Work from an issue in `PLAN.md` order. Keep PRs to one issue, and meet its acceptance criteria with tests.
- Changing an architectural decision means a new ADR in `docs/decisions/` (next number, short: context / decision / consequences). Don't silently contradict an existing ADR.
- When the owner redirects, update the relevant doc (`docs/*.md`, ADR, or skill) in the same PR so taste persists.
- Update `docs/ARCHITECTURE.md` when components, identities, or permissions change. The permission table must stay accurate.
- Ask the owner before anything outward-facing or hard to reverse: creating GitHub repos/Apps, GCP projects, DNS changes, publishing, rotating credentials.
