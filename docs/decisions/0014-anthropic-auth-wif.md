# ADR-0014: Anthropic auth is Workload Identity Federation everywhere; no API keys

- Status: accepted
- Date: 2026-10-29
- Amends: ADR-0004 decision 1, ADR-0011 (session creation), ARCHITECTURE §2.4 and §5.1

## Context

ADR-0004 had unattended runs authenticate with an API key from the linked Console org, stored in Secret Manager. ADR-0012 then moved the security audit to Anthropic Workload Identity Federation (WIF): the job exchanges a short-lived OIDC token for a ~10-minute Anthropic token, and no key exists to leak or rotate. WIF tokens bill to their workspace the same way a key does, so the credit and workspace spend limits work unchanged. Every other factory component that calls Anthropic runs where an OIDC identity is available.

## Decision

1. **No Anthropic API keys in the factory.** Every unattended caller authenticates through WIF to a Console service account. That account is a member of `globalhost-runners` only, and each caller (role) has its own federation rule, so revoking one doesn't affect the others.

   | Caller | OIDC identity | Rule match |
   |---|---|---|
   | Security audit (ADR-0012) | GitHub Actions, environment `security-audit` | immutable subject, claims, CEL (as built) |
   | Dispatcher creating Managed Agents sessions (ADR-0011) | GitHub Actions, environment `globalhost` in each product repo | one rule for all the owner's repos: subject prefix `repo:anlinguist@47403803/*`, claims `repository_owner` and `repository_owner_id`, CEL on `event_name` and `job_workflow_ref` (`.github/workflows/globalhost.yml`) |
   | Shadow reviewer (ADR-0018) | GitHub Actions, environment `globalhost-review` in each product repo | one rule for all the owner's repos: subject prefix `repo:anlinguist@47403803/*`, claims `repository_owner`, `repository_owner_id` and `environment`, CEL on `event_name` and `job_workflow_ref` (`.github/workflows/globalhost-review.yml`) |
   | Cloud Run Job runner (fallback) | Google identity token for `sa:runner` from the metadata server | `sub` = SA unique ID **and** `email`, audience `https://api.anthropic.com` |
   | Local runs (`globalhost run`, owner's machine) | Google identity token for `sa:globalhost-local` (no GCP roles), minted by the owner through `generateIdToken` | same as the runner row |
   | P1-00 spike (local, throwaway) | Google identity token for `sa:globalhost-spike`, minted by the owner through SA impersonation | same as the runner row |

   A Managed Agents session itself holds no Anthropic credential. The dispatcher creates and drives it.

   A new product repo needs no Console setup: it reuses the shared dispatcher and review rule and service-account IDs as repo variables. Those IDs aren't secret, but they stay out of this public repo. A repo outside the owner's account would need its own rules.
2. **ADR-0004 stands otherwise:** the linked org and credit, auto-reload off, workspaces with spend limits, the factory caps, and the model-per-role rules are unchanged. Its decision 1 now reads "unattended runs authenticate with WIF tokens for service accounts in the linked org".
3. **Exceptions need an ADR.** If a future host has no OIDC identity (for example a Cloudflare Worker hosting the Phase 3 chat agent), using a key there requires its own ADR. The key would live in Secret Manager, in its own workspace with a spend limit.

## Consequences

- **Secret Manager loses `anthropic-api-key`** (P1-04). `sa:runner` reads no secrets.
- **The fallback runner's residual risk shrinks.** An agent in the container can still mint Anthropic tokens through the metadata server, but only ~10-minute ones, only while the job runs, and capped by the workspace limit. There's no long-lived key to take away.
- **Owner setup per caller (role), not per repo:** one Console service account plus one federation rule, using the Connect workload wizard. Its IDs become non-secret config (repo variables or runner env).
- **The runner key created in P0-04 is unused.** The owner deletes it in Console.
