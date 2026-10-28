# ADR-0010: Rigid kernel, fluid stack — integrations instead of baked-in vendors

- Status: proposed
- Date: 2026-10-27

## Context

The first draft read as rigid: profiles bundled specific choices (Firestore/Neon, Cloud Run, a given auth provider), and changing the database, auth, or email provider looked like factory work. The owner wants to change any product's stack at any time, let agents set up new vendors autonomously, and use the vendors' MCP servers (Cloudflare, Resend, Sentry, PostHog, Neon, …) to do it.

## Decision

Split the system into three layers with different rules.

### 1. Kernel — deliberately rigid, deliberately small

What the factory guarantees for every product, regardless of stack:
- the loop (issue → plan → build → verify → review → preview → owner gate → release → observe);
- the trust model (who can trigger, untrusted-input handling);
- the credential boundary (agents never hold prod-write credentials; prod changes happen only through merged code or an owner-approved ops request);
- budgets, kill switch, audit trail (every change is a GitHub artifact).

Changing the kernel is a factory-repo PR plus an ADR.

### 2. Stack — fluid, owned by each product

Framework, database, auth, email, hosting, analytics, payments are **product decisions**, recorded in the product repo:
- `docs/product/STACK.md`: current choices, why, and the integration each uses;
- `docs/product/DECISIONS.md`: append-only log, including stack changes.

Profiles shrink to **contracts about the shape of the deliverable** — how it's verified, what the preview gives the owner, how it reaches users. They say nothing about which DB or auth provider. Profile defaults (the "golden path" for new products: e.g. Neon + Better Auth + Resend) are suggestions in skills, not constraints. Any facet of a profile can be overridden in `factory.yaml`, and `profile: custom` lets a repo supply its own verify/preview/release commands. That's the escape hatch for anything the factory hasn't seen before.

A stack change is an ordinary issue with a **stack-change plan** (options, cost, migration and rollback, data handling). Once the owner approves it, the agent does the rest.

### 3. Integrations — pluggable vendor connections

An integration is a registry entry in the factory repo (`integrations/<id>.yaml`), added by PR like anything else:

```yaml
id: resend
kind: email
mcp:                       # how agents operate/inspect it
  server: "@resend/mcp"    # or a remote URL
  tools: { dev: all, prod: [list-domains, get-email, list-logs] }   # prod: read-only
iac:                       # declarative desired state, if a provider exists
  pulumi: null             # e.g. "@pulumi/cloudflare", "neon" community provider
  fallback: script         # idempotent provisioning script committed to the product repo
secrets:                   # names only; values set by owner or minted by the integration in dev
  dev:  [RESEND_API_KEY_DEV]     # restricted key: test domain, sending only
  prod: [RESEND_API_KEY]         # never mounted into agent runs
cost: "free tier 3k emails/mo"
```

Rules:
- **Dev scope is autonomous.** Builder runs may mount an integration's MCP server with **dev-scoped credentials** to create and configure resources in dev (a Neon branch, a Resend test domain, a Cloudflare dev Worker, a PostHog dev project). Whatever they create must also be captured as code (IaC or an idempotent script) in the same PR, so prod can be reproduced from the merge.
- **Prod reads are allowed; prod writes are gated.** Agents may use read-only prod tools (Sentry issues, PostHog insights, Resend logs) for diagnosis. Prod mutations happen through one of two paths:
  1. **Merged code**: the release workflow applies IaC/scripts with prod credentials. This is the default.
  2. **Ops request**: for things that aren't code (verify a DNS record, rotate a key, toggle a vendor setting), the agent posts an `ops:` comment listing the exact MCP/API calls. The owner approves with `approved:ops` on that comment's hash, and a trusted executor (not the agent) runs exactly those calls with prod credentials and logs the result on the issue.
- **Interactive mode is unrestricted.** When the owner works in Claude Code (Max plan) with their own MCP servers, anything goes. Afterwards, `globalhost reconcile` asks the agent to turn what was done into IaC/scripts plus a `DECISIONS.md` entry, via a PR, so the factory's picture of the product stays true.
- **Adding a vendor is cheap.** New integration = registry entry + dev/prod secrets set by the owner (or a vendor OAuth connection) + optional skill. No kernel change.

## Consequences

- The factory's opinions now sit only where they protect the owner (credentials, gates, budgets).
- Real autonomy in dev: agents can try a new database or auth provider end-to-end in a preview without asking.
- Cost: each integration needs a dev-scoped credential, and not every vendor supports restricted keys. Where a vendor can't scope credentials, its MCP server isn't mounted in unattended runs; that vendor works interactively or through ops requests only.
- Phase 1 stays thin. The integration registry arrives in Phase 2, starting with Cloudflare, Neon, Resend, Sentry and PostHog.
