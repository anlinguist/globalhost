# ADR-0016: Preview routing without KV; who can deploy a preview

- Status: accepted
- Date: 2026-11-02
- Amends: ADR-0007 (routing state, credentials at the edge)

## Context

ADR-0007 had the preview deploy job write each PR's tagged revision URL to Workers KV, which put a Cloudflare credential in every product's PR workflow. Building P1-11 showed:
- Cloud Run tag URLs are deterministic: `pr-<n>---<service>-<project number>.<region>.run.app`. Nothing per-PR needs storing at the edge.
- Preview apps are agent-written from untrusted issue text, and the owner's Access JWT is valid for every `*.globalhost.ai` preview. Whatever forwards that JWT to app code hands the owner's session to it.
- A `pull_request` workflow runs the PR's own copy of the workflow file, with the actor set to whoever caused the event. Pinning credentials to the actor is not enough: a collaborator can push an edited workflow, and the token is minted the next time the owner or the bot touches the PR (close/reopen, label, update branch, a bot push).

## Decision

- **No KV.** The router Worker gets a static `{ "<product>-<part>": "<service host>" }` map from Pulumi and derives `pr-<n>---<host>`. A missing tag is Cloud Run's own 404. Teardown is removing the tag. No workflow holds a Cloudflare credential; only the owner's `pulumi up` does.
- **Credentials never reach preview code.** The Worker drops the `CF_Authorization` cookie, strips `Domain=` from response cookies (no cookie tossing across previews), and removes client-sent forwarding and identity headers. `access-guard` verifies the JWT, then strips it before proxying.
- **Credentials are pinned to the default branch's workflow file.** Two workflows per product repo:
  - `globalhost-preview-build.yml` (`pull_request`, PRs into the default branch): builds the image and uploads it as an artifact. It has no `id-token` permission and no credentials of any kind.
  - `globalhost-preview.yml` runs only from the default branch, on `workflow_run` after a successful build (deploy) and on `pull_request_target` `closed` (teardown). It never checks out or executes PR code; it `docker load`s the built image.
  - The WIF provider `<product>-preview` requires `job_workflow_ref == <repo>/.github/workflows/globalhost-preview.yml@refs/heads/<default>`, `ref` the default branch, GitHub-hosted runners, and either `pull_request_target` or a `workflow_run` whose actor is the owner or the factory bot. No PR can change what runs with these identities.
- **Two identities, chosen by job environment.** The deploy job (`environment: preview-deploy`) gets `preview-deployer`: push images, deploy tagged revisions, update authorized domains (a custom role with only `firebaseauth.configs.get/update`). The screenshot job (`environment: preview-screenshots`) runs a browser on PR code, so it gets `preview-screenshots`: only the Access CI token and creating screenshot objects.
- **Dev projects share the $25 factory budget** (ARCHITECTURE §5.2): their spend counts toward the alerts and the `paused` flag. The preview workflows don't read that flag yet; preview cost is bounded by scale-to-zero and `max-instances=1`.
- **The guard starts first.** In each preview service the `app` container depends on `guard`, so the guard holds the ingress port before PR code runs.
- **One Access app and one CI token for all previews**, acceptable with one product. With a second product, each gets its own Access application and token, so one product's screenshot token can't open another's previews. The token lasts a year; rotation is `pulumi up` after tainting it (tracked in globalhost-ops).
- **`app.globalhost.ai`** (the PWA, ADR-0003) must get its own Access application with a separate AUD, and a Worker route that excludes it, before it launches.

## Consequences

- One fewer secret to rotate and no edge state to clean up. Adding a part is a Pulumi change (new service and map entry), which is also what creates its service.
- Collaborators' PRs get a build but no deploy; the owner pushing to the branch (or re-running the build) makes the next deploy run as the owner. A PR closed by anyone is torn down.
- The preview `*.run.app` service is `allUsers`-invokable by design; `access-guard` is the only gate there, so it carries adversarial tests and runs as the ingress container.
