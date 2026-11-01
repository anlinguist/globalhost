# ADR-0006: Stay on free GitHub; enforce the gate through credentials, not plan features

- Status: proposed; amended by ADR-0015 (agent merge through a separate merge App and a required check, on repos with enforced rulesets)
- Date: 2026-10-27

## Context

Owner doesn't want to pay for GitHub. On a free personal account:
- **Public repos:** rulesets/branch protection work (require PR, required checks, block force-push/deletion), secret scanning + push protection and CodeQL are free, Actions minutes are unlimited.
- **Private repos:** branch protection/rulesets aren't enforced; Actions has 2,000 min/month.
- **Merge queue:** org-owned repos only (private ones also need Enterprise Cloud). Not available on personal repos.
- GitHub Apps are free on any plan.

## Decision

1. Stay on free. Factory repo and products stay where they are (`anlinguist/*`, `readefine-app/*`).
2. Agent identity is a **GitHub App `globalhost-ai`** owned by `anlinguist`, installed per repo. Unlike `GITHUB_TOKEN`, App-created PRs trigger CI. No `workflows` or `administration` permission.
3. The "merge is the only path to prod" guarantee rests on, in order:
   - prod deploy credentials bound by WIF attribute conditions to `refs/heads/<default>` + `release.yml` (holds on any plan);
   - the publisher only pushes `factory/*` branches (trusted code; agents hold no write token);
   - the App can't edit workflows, so it can't rewrite the release path;
   - public repos additionally get rulesets.
4. Replace merge queue with a **"ship" action** (CLI/PWA/label `factory:ship`): rebase branch on latest base, wait for green CI on that SHA, merge, under a per-repo concurrency lock. Fine at solo volume.
5. Keep long agent runs off Actions minutes for private repos (Cloud Run Jobs).

## Upgrade triggers

- If a private product needs enforced protection: GitHub Pro ($4/mo) enables it on private personal repos.
- If merge queue becomes necessary: move public repos into a free org.
