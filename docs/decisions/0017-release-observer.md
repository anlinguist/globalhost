# ADR-0017: A read-only release observer on prod projects

- Status: accepted
- Date: 2026-11-02
- Relates to: ADR-0006 (prod reached only by merging), ADR-0016 (identities pinned to the default branch's workflow)
- Amended by: ADR-0019 (a successful build is not a deployment: ✅ and issue closing need the merged commit confirmed live; the role also gets `run.services.get` and `run.revisions.get`)

## Context

PLAN P1-12: after a factory PR merges, the factory reports whether it reached prod ("Deployed to prod via Cloud Build `<id>` ✅") and closes the issue only then. Adopted repos keep their own deploy (numu-know: a Cloud Build trigger on `main`), so the factory has to read that build. Until now no factory identity had any role on a prod project.

## Decision

- **One identity per product, read-only, on Cloud Build only.** `<product>-release-observer` lives in `globalhost-factory`. Its one grant is a custom role `globalhostReleaseObserver` in the prod project with `cloudbuild.builds.get` and `cloudbuild.builds.list`, which cover builds and triggers. It can't read logs (they live in Cloud Logging and GCS), can't start, retry or cancel builds, and has no other role on any project.
- **Pinned to the default branch's workflow.** WIF provider `<product>-release` requires `event_name == push`, `ref` the default branch, both `job_workflow_ref` and `workflow_ref` equal to `<repo>/.github/workflows/globalhost-release.yml@<default>` (so no other workflow can call it and get the token), and a GitHub-hosted runner. A PR can't change what runs with it.
- **Public comments carry only identifiers.** Product repos may be public, so the report holds the build ID, its state, and a Cloud Console link that only project members can open. The adapter's `detail` text (which includes Cloud Build's `statusDetail`) is for logs, never for comments; the observe step reads only the build ID and the state. Never logs or substitutions either.
- **Issues close on deploy, not on merge.** Factory PRs say `Refs #N` instead of a closing keyword. The observer closes the issue after a successful deploy and leaves it open, with a comment, on failure.

## Consequences

- The first factory access to prod is read-only and limited to build metadata. A leaked token would show build IDs, statuses, trigger configs and the commits that were deployed.
- Builds and triggers expose substitution values, step `args` and `env`, `options.env`, service accounts and buckets (Secret Manager references show names only). Anything secret there was already readable by project Viewers, but this token is minted on a GitHub runner, so: keep secrets in Secret Manager, not in substitutions, args or env. The owner checks numu-know's trigger before the first apply. `builds.list` can't be limited to one trigger, so the observer can read every build in the project.
- A deploy adapter that *acts* on prod (`sa:<product>-release`, ARCHITECTURE §2.7) is still separate and still needs its own decision.
