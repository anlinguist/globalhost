# ADR-0007: Preview ingress — Cloudflare Worker router + Access on *.globalhost.ai; prod stays on product domains

- Status: proposed
- Date: 2026-10-27

## Context

Previews must sit behind Cloudflare Access, cost ~nothing, and work for many products. Prod releases go to each product's own domain (unchanged). Constraints:
- Cloudflare's free Universal SSL covers apex + one wildcard level (`*.globalhost.ai`), not `*.x.globalhost.ai`.
- Google Cloud load balancers (the usual Cloud Run custom-domain path) cost ~$18+/month — over budget.
- Cloud Run domain mappings are limited and awkward behind Cloudflare's proxy.
- The `*.run.app` URL must not be a way around Access.

## Decision

- Add `globalhost.ai` to Cloudflare (free plan).
- Hostname scheme (one level): `<product>-<part>-pr-<n>.globalhost.ai`; dev: `<product>-<part>-dev.globalhost.ai`. The factory PWA lives at `app.globalhost.ai`, and the apex can be a landing page.
- **Cloudflare Access** application on `*.globalhost.ai` allowing only the owner's email (free ≤50 users).
- **Cloudflare Worker** on `*.globalhost.ai/*` parses the hostname and proxies to the Cloud Run **tagged revision URL** (`https://pr-<n>---<service>-<hash>.<region>.run.app`). The base URL per product/part comes from Workers KV, written by the preview deploy job.
- Each preview Cloud Run service runs an **`access-guard` sidecar** (factory-built image) as the ingress container. It validates the `Cf-Access-Jwt-Assertion` JWT (team domain + audience) and proxies to the app container over localhost, with zero app changes. Health checks bypass it on a separate port.
- Cleanup: on PR close, remove the tag, delete the KV entry, and prune images.

## Setup facts (P0-03, 2026-10-27)

- Cloudflare account `b310d413b53aede67348d9442de1aca6` (owner's personal account).
- Zone `globalhost.ai`: id `859de9f350a6d4b89ad676abcf214d9a`, Free plan, full setup. Cloudflare nameservers: `brynne.ns.cloudflare.com`, `vick.ns.cloudflare.com` (the registrar is GoDaddy).
- Zero Trust team domain: `broken-haze-4579.cloudflareaccess.com`. This is the `iss` the `access-guard` checks; the auto-generated name was kept on purpose.

## Who can get in, and how

- **Owner (human):** Access policy = your email via an identity provider (GitHub or Google login, both passkey-capable) **plus Access independent MFA with a WebAuthn passkey** (built-in biometrics/security key; supported since April 2026). Session duration is 30 days per device, so on your phone it's one Face ID tap about once a month. No email codes.
- **Machines** (Playwright screenshots in CI, reviewer agent checking a preview, composite previews calling each other): **Access service tokens** (`CF-Access-Client-Id`/`Secret` headers), one per purpose, held in Secret Manager. They're allowed by a separate `non_identity` policy and can be revoked individually. Agents get the preview service token only (read-only browsing of previews), never anything prod.
- **Preview → backing services:** previews only reach dev resources (dev DB branch, dev Firebase, vendor sandboxes). Prod services never trust a preview.
- **Guest share (optional, later):** a time-boxed Access policy for a specific email (e.g. to show a tester), created via an `ops:` request and auto-expiring.

## Where the guard lives

The **authentication** (login, passkey, service tokens) happens at Cloudflare's edge (Access + Worker). The **`access-guard`** is not app code: it's a separate container deployed next to each preview app in the same Cloud Run service (a sidecar on the GCP side). It only checks that a request carries a valid Cloudflare-signed Access JWT, which shuts the "hit the `*.run.app` URL directly" bypass. Apps stay unchanged. If we ever move previews to Cloudflare-hosted runtimes (Workers/Containers), the guard disappears because there's no public origin to bypass.

## Consequences

- Cost: $0 (Workers free 100k req/day, KV free tier, Cloud Run scale-to-zero).
- Apps see `Host: *.run.app` upstream; apps that need their public origin (OAuth redirect URIs, absolute URLs) get it via `X-Forwarded-Host` + a `PUBLIC_ORIGIN` env var set per preview.
- Firebase Auth authorized domains don't accept wildcards. The preview deploy registers each host via the Identity Toolkit API (dev project only) and removes it on close.
