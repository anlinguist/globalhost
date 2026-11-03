# ADR-0019: A successful build is not a deployment

- Status: accepted
- Date: 2026-11-03
- Amends: ADR-0017 (release observer)

## Context

The release observer (P1-12, ADR-0017) posted "Deployed to prod via Cloud Build `<id>` ✅" and closed the factory issue whenever the Cloud Build build triggered by the merge succeeded. A build's SUCCESS only means its steps exited 0. On the pilot repo the trigger's build deployed nothing, so every merge got a false ✅ and issues were closed although nothing was deployed. The observer was reporting what the trigger did, not what prod serves.

## Decision

- **"Deployed" means the merged commit is what prod serves.** Deploy adapters get an optional, read-only `verifyLive(handle)` in core (profile-agnostic: `live` / `not-live` with a reason / `unverifiable`). The observer posts ✅ and closes issues only on `live`. An adapter without `verifyLive` can never report a deploy.
- **`cloud-build-trigger` checks the Cloud Run service.** Its config gains `cloudRun: { service, region }`. The project is `environments.prod.gcpProject`, never another environment. After the build succeeds, the adapter:
  1. refuses a build with no `results.images` (nothing was pushed, so nothing this check can see was deployed);
  2. reads the service (`run.googleapis.com/v2`, `services.get`) and requires 100% of `trafficStatuses` on one revision, with the service not reconciling;
  3. reads that revision (`revisions.get`) and requires it to be Ready and to run this build's image. A pinned digest must equal a digest the build pushed. Without a digest, the tag must be the full or short (7+) commit SHA, in a repository the build pushed to. A digest that doesn't match wins over a matching tag.
- **Bounded wait, then fail closed.** A rollout may lag the build, so a not-yet-live result is retried every poll for up to 5 minutes after the build succeeded. After that, the observer posts a fixed-text ❌ naming the failed check (no images built, service not serving this commit, split traffic, revision not ready) and fails the job. Cloud Run API errors are ⚠️ and fail the job: 401/403/404 at once, 429/5xx after the window. The issue stays open in every case.
- **No target, no claim.** Without `cloudRun` (or without `environments.prod`), the observer posts "Cloud Build `<id>` succeeded, but deployment can't be verified (no deploy target configured)", with no ✅, and leaves the issue open. The job stays green: this is a configuration gap, not a failed deploy.
- **Least privilege.** The observer's custom role gains `run.services.get` and `run.revisions.get` on the prod project, with no `list`, IAM or log permissions. Comments still carry only fixed text, the build ID and a console link: never image names, digests or revision names.

## Consequences

- Build configs must list their images under `images:`, so Cloud Build records `results.images`. A build that only runs `docker push` as a step is reported as having built nothing.
- Deploys that use neither a digest nor a commit-SHA tag (e.g. `:latest`) can't be verified and are reported ❌. That is the intended behaviour: the factory can't tell which commit such a deploy serves.
- A leaked observer token can now also read the configuration of every Cloud Run service and revision in the prod project. Images, env var values and secret references are visible, but not secret payloads. As before, secrets belong in Secret Manager, not in plain env vars.
- The ✅ claims made before this change are not trustworthy evidence of a deploy (PLAN P1-12).
