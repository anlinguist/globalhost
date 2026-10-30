# @globalhost/dispatch

The dispatcher and publisher (PLAN P1-07, ARCHITECTURE §2.3). It's the logic behind the workflow installed in product repos, `templates/.github/workflows/globalhost.yml`. That workflow runs it through the composite action `packages/action`, pinned by commit SHA.

## Flow

```
issues.labeled / issue_comment
  └─ gate      (read-only GITHUB_TOKEN, no environment)
       factory.yaml from the default branch → trust gate (owner IDs) → start | resume | ignore
  └─ dispatch  (environment `globalhost`; id-token: write)
       WIF → GCP as sa:globalhost-gh-dispatch
       kill switch, daily budget, branch claim, builder slot      (gs://globalhost-control)
       Managed Agents session via the GitHub OIDC → Anthropic rule (ADR-0014)
       archive outputs                                            (gs://globalhost-runs)
       App installation token (key from Secret Manager, minted per write)
       publisher: re-verify bundle → path policy → push factory/issue-<n> (never forced)
                  → draft PR → run report + labels
```

**Run and publish share one job.** The agent never executes in the Actions job: it runs in the Managed Agents sandbox and returns a git bundle. The job only fetches that bundle into a bare repo, with no checkout and no hooks. Splitting the job would add an artifact hop without separating any untrusted code.

**What triggers what:**

| Trigger | Result |
|---|---|
| An owner applies `factory:plan` | Planner run. The plan is posted as an issue comment, and the issue is labeled `factory:planned`. |
| An owner applies `factory:build` | Builder run, which starts from the latest plan if there is one. It pushes `factory/issue-<n>`, opens a draft PR, and labels the issue `factory:in-review`. |
| An owner comments on a `factory/*` PR | The builder's session resumes with the comment as feedback, plus a budget top-up of `limits.perRunUsd`. A comment starting with `>`, or containing `[no-factory]`, is ignored. |
| Anything by a non-owner | Nothing. No run and no comment. |

The session ID travels in a hidden marker on the bot's run-report comment. Only markers on comments by the App's bot user are trusted, and agent text has `<!--` neutralized before it's posted.

**Refusals** are posted as a comment, and nothing runs. They happen when:
- the factory is paused;
- today's per-repo spend plus `perRunUsd` would exceed `dailyUsd`;
- `factory/issue-<n>` already exists, which is the branch claim: steer the existing PR instead;
- all `maxConcurrentBuilders` slots are busy.

## Product-repo setup

`globalhost install` will automate this (P1-09). Until then, set it up by hand, once per repo:

1. **Factory side:** make sure the factory infra is applied (P1-04) with the repo in `dispatchRepos`, and that the `globalhost-ai` App is created and installed on the repo (P1-05).
2. **Anthropic Console:** add a federation rule for the repo's dispatcher. Use Connect workload → GitHub Actions with these settings:
   - the same immutable-subject form as the audit's rule;
   - environment `globalhost`;
   - workspace `globalhost-runners`.
3. **In the product repo:**
   - Create an environment `globalhost` whose deployment branches are limited to the default branch.
   - Add these repo variables. They're identifiers, not secrets:

     | Variable | Value |
     |---|---|
     | `GLOBALHOST_WIF_PROVIDER` | stack output `workloadIdentityProvider` |
     | `GLOBALHOST_DISPATCH_SA` | `globalhost-gh-dispatch@globalhost-factory.iam.gserviceaccount.com` |
     | `GLOBALHOST_APP_ID`, `GLOBALHOST_APP_SLUG` | printed by `infra/github-app` |
     | `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_WORKSPACE_ID` | from step 2 |

   - Commit `factory.yaml` and `.github/workflows/globalhost.yml`. In the workflow, the placeholder SHA is replaced with a `globalhost` commit on `main`.
