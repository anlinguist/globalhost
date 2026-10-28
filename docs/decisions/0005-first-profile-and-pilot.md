# ADR-0005: First profile = web-app; pilot repo = anlinguist/numu-know

- Status: proposed
- Date: 2026-10-27

## Context

Phase 1 needs one small, real, existing repo onboarded at L1. Candidates the owner named: Bibliacra and numu-know (both have users; numu-know fewer).

| | numu-know (`anlinguist/numu-know`) | Bibliacra |
|---|---|---|
| Shape | single Next.js 16 / React 19 app (App Router, Mantine, Firebase, Algolia) | split across `biblia-sacra` (React, last push 2023), `biblia-sacra-be` (Express), `bibliacraRN` (React Native), native iOS |
| Activity | pushed Jan 2026 | mostly 2023, backend Jan 2025 |
| Visibility | **public** → free rulesets, unlimited Actions minutes, free secret scanning | private |
| Deploy | Cloud Build triggers: `main` → `numu-know`, `staging` → `staging-numu-know` (project `numu-know`) | Cloud Run (project `biblia-sacra`) |
| Data | Firestore (native) | Firebase |
| Tests/CI | none | none found |
| Secrets | clean history | active SA key committed (resolved under P0-01) |
| Users | fewer | more |

## Decision

- **Pilot: numu-know**, profile **web-app**, deploy adapter **cloud-build-trigger** (existing deploy unchanged), autonomy **L1**.
- Its old Express backend (`numu-know-backend`, `numu-know-node-server` service) stays out of scope for Phase 1 — later a good second part for the `service` profile.
- Bibliacra comes later and likely motivates a `mobile` profile (React Native/iOS), which is out of scope for the first three profiles.

Rationale: single repo, modern stack, public repo (gets real branch protection on the free plan — ADR-0006), existing staging environment and Cloud Build deploys to keep via an adapter, lower user count. Its lack of tests is a feature for the pilot: it exercises the "safety nets before feature work" onboarding stage.

## Open items for the onboarding issue

- Branch flow: `develop` is 10 commits behind `main`, `staging` equals `main`. Proposal: factory PRs target `main`; per-PR previews replace the need for `staging` (keep the trigger, stop using the branch).
- Previews use a new `numu-know-dev` Firebase project with seed data, never prod data.
- Firebase Auth authorized domains don't support wildcards; previews either add each preview host via API at deploy time or use a fixed preview host per PR slot. Resolve in P1-11.
