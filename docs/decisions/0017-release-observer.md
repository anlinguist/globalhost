# ADR-0017: A read-only release observer on prod projects

- Status: accepted
- Date: 2026-11-02
- Relates to: ADR-0006 (prod reached only by merging), ADR-0016 (identities pinned to the default branch's workflow)

## Context

PLAN P1-12: after a factory PR merges, the factory reports whether it reached prod ("Deployed to prod via Cloud Build `<id>` ✅") and closes the issue only then. Adopted repos keep their own deploy (numu-know: a Cloud Build trigger on `main`), so the factory has to read that build. Until now no factory identity had any role on a prod project.

## Decision

- **One identity per product, read-only, on Cloud Build only.** `<product>-release-observer` lives in `globalhost-factory`. Its one grant is a custom role `globalhostReleaseObserver` in the prod project with `cloudbuild.builds.get` and `cloudbuild.builds.list`, which cover builds and triggers. It can't read logs (they live in Cloud Logging and GCS), can't start, retry or cancel builds, and has no other role on any project.
- **Pinned to the default branch's workflow.** WIF provider `<product>-release` requires `event_name == push`, `ref` the default branch, `job_workflow_ref == <repo>/.github/workflows/globalhost-release.yml@<default>`, and a GitHub-hosted runner. A PR can't change what runs with it.
- **Public comments carry only identifiers.** Product repos may be public, so the report holds the build ID, its state, and a Cloud Console link that only project members can open. Never `statusDetail`, logs or substitutions.
- **Issues close on deploy, not on merge.** Factory PRs say `Refs #N` instead of a closing keyword. The observer closes the issue after a successful deploy and leaves it open, with a comment, on failure.

## Consequences

- The first factory access to prod is read-only and limited to build metadata. A leaked token would show build IDs, statuses, trigger configs and the commits that were deployed.
- Trigger configs can hold substitution values. Anything secret in a trigger was already readable by everyone with Viewer on the project; keep secrets in Secret Manager, not in substitutions.
- A deploy adapter that *acts* on prod (`sa:<product>-release`, ARCHITECTURE §2.7) is still separate and still needs its own decision.
