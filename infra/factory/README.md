# infra/factory

Pulumi program for the factory's own GCP resources in project `globalhost-factory` (PLAN P1-04, ARCHITECTURE §5). Stack `prod`, state in `gs://globalhost-pulumi-state`, secrets encrypted with Cloud KMS (ADR-0008).

## What it manages

| Resource | Name | Notes |
|---|---|---|
| APIs | see `REQUIRED_APIS` in `src/factory.ts` | never disabled on destroy |
| Bucket | `globalhost-runs` | run artifacts (bundle, `run.json`, session exports); deleted after 30 days; uniform access, public access prevention |
| Bucket | `globalhost-control` | `state.json` (kill switch, spend), lock objects; versioned; noncurrent versions deleted after 30 days or beyond 100 newer |
| WIF pool | `github` | **imported**, not created: it already exists from `infra/bootstrap/security-audit.sh`. `protect: true`. That script still owns the audit provider `github-actions` |
| WIF provider | `github/globalhost-dispatch` | GitHub OIDC; condition pins `repository_owner_id` 47403803, the environment `globalhost`, and each configured repo ID on its default branch |
| Service account | `globalhost-gh-dispatch` | the dispatcher (`sa:gh-dispatch`). Bucket- and secret-level roles only; impersonable only via `principalSet://…/attribute.dispatch/<repo id>@globalhost` |
| Secret | `github-app-key` | no version: the owner adds it with `infra/github-app`. Authoritative IAM policy: only `sa:gh-dispatch` can access it |
| Budget | `globalhost-factory-monthly` | $25/month on this project, 40/80/100% → Pub/Sub `globalhost-budget-alerts` |
| Function | `globalhost-budget-pause` | 2nd gen, Node 24, Pub/Sub trigger. At ≥100% sets `paused: true` in `gs://globalhost-control/state.json` with a generation-match write. Never un-pauses |
| Service accounts | `globalhost-budget-pause`, `globalhost-fn-build` | function runtime/trigger identity (can write only `state.json`), and its build identity (instead of the default compute SA) |
| Artifact Registry | `globalhost-functions` | only because Cloud Functions 2nd gen builds a container; keeps the 2 newest versions |
| Bucket | `globalhost-functions-source` | the function's source zip (one object, replaced by Pulumi on change) |

### Permissions of `sa:globalhost-gh-dispatch`

| Scope | Role | Why |
|---|---|---|
| `globalhost-control` | `roles/storage.objectUser` | read/write/delete `state.json`, spend records and lock objects (compare-and-swap via generation match) |
| `globalhost-runs` | `roles/storage.objectCreator` | archive run artifacts (no overwrite or delete) |
| `globalhost-runs` | `roles/storage.objectViewer` | read run artifacts |
| secret `github-app-key` | `roles/secretmanager.secretAccessor` | mint App installation tokens |

Nothing at project level. It does not talk to Anthropic: the dispatcher job authenticates there with its own GitHub OIDC token (ADR-0014).

### Deliberately not here

- **The state bucket and KMS key.** `infra/bootstrap/pulumi-state.sh` creates them. Pulumi can't create the backend it stores its state in, and a program that manages its own decryption key can destroy it. Importing them would only add that risk.
- **Runner infrastructure.** No Cloud Run Job, no runner image registry, no `sa:runner`: Managed Agents hosts the sandbox (ADR-0011). The Cloud Run Job fallback is built only if a later requirement fails.
- **An Anthropic key.** Every caller uses WIF (ADR-0014).

## Owner steps (apply)

Prerequisites: `gcloud auth login` and `gcloud auth application-default login` as the owner; Pulumi CLI; `pnpm i` at the repo root. The security-audit bootstrap has already run, so the `github` pool exists.

```sh
# 1. Backend: state bucket + KMS key (idempotent)
infra/bootstrap/pulumi-state.sh

# 2. Stack (once). Adds secretsprovider/encryptedkey to Pulumi.prod.yaml; commit that change.
cd infra/factory
pulumi login gs://globalhost-pulumi-state
pulumi stack init prod --secrets-provider="gcpkms://projects/globalhost-factory/locations/global/keyRings/pulumi/cryptoKeys/state"
pulumi config set --secret billingAccount <BILLING_ACCOUNT_ID>   # gcloud billing projects describe globalhost-factory

# 3. Build and apply
pnpm --filter @globalhost/infra-factory build
pulumi preview      # expect: 1 import (github pool), the rest create
pulumi up
pulumi stack output
```

To add a product repo, append it to `dispatchRepos` in `Pulumi.prod.yaml` (name, numeric ID from `gh api repos/<owner>/<repo> --jq .id`, default branch) and `pulumi up`.

In each product repo, create the GitHub environment `globalhost` and restrict its deployment branches to the default branch. The dispatcher job declares `environment: globalhost`.

## Checks after apply (P1-04 AC)

```sh
# gh-dispatch holds no project-level role (expect no output)
gcloud projects get-iam-policy globalhost-factory --format=json \
  | jq -r '.bindings[] | select(.members[] | contains("globalhost-gh-dispatch")) | .role'
# Only gh-dispatch on the App key secret
gcloud secrets get-iam-policy github-app-key --project=globalhost-factory
# Simulated 100% budget message flips paused (then resume by hand)
gcloud pubsub topics publish globalhost-budget-alerts --project=globalhost-factory \
  --message='{"budgetDisplayName":"globalhost-factory-monthly","alertThresholdExceeded":1.0,"costAmount":25.0,"budgetAmount":25.0,"currencyCode":"USD"}'
gcloud storage cat gs://globalhost-control/state.json
```

## Development

`pnpm test` runs the program against Pulumi mocks (`test/factory.test.ts`) and the budget function's logic against a fake store with generation-match semantics (`test/budget-pause.test.ts`).

The function's deployed dependencies are locked separately in `functions/budget-pause/deploy/` (`package.json` + `package-lock.json`, Cloud Build runs `npm ci`). Regenerate the lockfile with `npm install --package-lock-only --ignore-scripts` in that directory after changing the version.
