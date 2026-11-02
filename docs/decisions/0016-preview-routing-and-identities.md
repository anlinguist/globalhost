# ADR-0016: Preview routing without KV; who can deploy a preview

- Status: accepted
- Date: 2026-11-02
- Amends: ADR-0007 (routing state, credentials at the edge)

## Context

ADR-0007 had the preview deploy job write each PR's tagged revision URL to Workers KV, which put a Cloudflare credential in every product's PR workflow. Building P1-11 showed:
- Cloud Run tag URLs are deterministic: `pr-<n>---<service>-<project number>.<region>.run.app`. Nothing per-PR needs storing at the edge.
- Preview apps are agent-written from untrusted issue text, and the owner's Access JWT is valid for every `*.globalhost.ai` preview. Whatever forwards that JWT to app code hands the owner's session to it.
- A `pull_request` workflow runs the PR's own workflow file, so the identity it can mint has to be limited by who triggered it, not by the file.

## Decision

- **No KV.** The router Worker gets a static `{ "<product>-<part>": "<service host>" }` map from Pulumi and derives `pr-<n>---<host>`. A missing tag is Cloud Run's own 404. Teardown is removing the tag. No workflow holds a Cloudflare credential; only the owner's `pulumi up` does.
- **Credentials never reach preview code.** The Worker drops the `CF_Authorization` cookie, strips `Domain=` from response cookies (no cookie tossing across previews), and removes client-sent forwarding and identity headers. `access-guard` verifies the JWT, then strips it before proxying.
- **Who can deploy:** the WIF provider `<product>-preview` accepts only that repo's `pull_request` events whose actor is the owner or the factory App's bot. The bot can't edit workflows (no `workflows` permission), and the owner reviews workflow changes. Others' PRs get no GCP token, so a changed workflow in their PR can't deploy anything. To preview someone else's PR, the owner re-pushes it to a branch.
- **Build has no credentials; deploy runs no PR code.** The workflow builds the image in a job without `id-token`, hands it over as an artifact, and a second job (factory-pinned scripts only) pushes, deploys and screenshots it.
- **Dev projects share the $25 factory budget** (ARCHITECTURE §5.2), so the budget-pause switch covers runaway previews.
- **`app.globalhost.ai`** (the PWA, ADR-0003) must get its own Access application with a separate AUD, and a Worker route that excludes it, before it launches.

## Consequences

- One fewer secret to rotate and no edge state to clean up. Adding a part is a Pulumi change (new service and map entry), which is also what creates its service.
- Collaborators' PRs don't get automatic previews.
- The preview `*.run.app` service is `allUsers`-invokable by design; `access-guard` is the only gate there, so it carries adversarial tests and runs as the ingress container.
