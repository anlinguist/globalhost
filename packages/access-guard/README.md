# @globalhost/access-guard

The ingress container of every Cloud Run preview service (ADR-0007, ARCHITECTURE §2.6). Cloudflare Access sits in front of `*.globalhost.ai`, and a Cloudflare Worker proxies to the Cloud Run tagged revision URL, forwarding the `Cf-Access-Jwt-Assertion` header. The guard rejects any request without a valid Access JWT, then streams the request to the app container on `127.0.0.1`. Apps need no changes.

## The threat it closes

A Cloud Run service is reachable at its public `*.run.app` URL (including each tagged revision's `pr-<n>---…run.app` URL). Without the guard, anyone who learns that URL skips Cloudflare Access entirely. The guard makes that URL useless without a token that Cloudflare signed for our Access application.

It also keeps the Access credential away from the app. A preview runs agent-written code, which is untrusted, and the Access JWT is valid on every `*.globalhost.ai` preview. A preview that saw the token could replay it against other previews. So the guard verifies the token and then removes it.

## What it checks

On every request except the health path:

- exactly one `Cf-Access-Jwt-Assertion` header, at most 8 KiB;
- compact JWS with header `alg` exactly `RS256`. `none`, `HS*` (including HMAC keyed with the RSA public key), `PS*`, `ES*` and anything else are rejected. The verifier is RSA-SHA256 whatever the token says. Tokens with a `crit` header are rejected;
- `kid` names a key from `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (RSA, at least 2048 bits);
- RSA-SHA256 signature over the header and payload;
- `iss` equals `https://<ACCESS_TEAM_DOMAIN>` exactly;
- `aud` (string or array) contains one of `ACCESS_AUD`;
- `exp` is present and not passed, and `nbf` and `iat` (when present) are not in the future, each allowing 60 s of clock skew.

Failures get `403 Forbidden` with a fixed body. The reason never appears in the response. It goes to a structured JSON log line (`{"severity":"WARNING","message":"request rejected","reason":"bad_audience",...}`) that never includes the token.

**Signing keys** are cached for 10 minutes. An unknown `kid` triggers a refetch (key rotation), but at most once every 30 s, and concurrent requests share one fetch, so a flood of made-up kids can't hammer the endpoint. If the keys can't be fetched, or the cache expires and the refetch fails, every request is rejected (fail closed).

## What the app receives

- Method, path, query and body unchanged. Bodies stream both ways with no buffering.
- `Host` as received (the `*.run.app` host), plus `X-Forwarded-Host`: the incoming `X-Forwarded-Host` if the Worker set one, else `Host`. Apps that need their public origin use this or `PUBLIC_ORIGIN`.
- Removed from the request: hop-by-hop headers (`Connection`, `Keep-Alive`, `TE`, `Transfer-Encoding`, `Upgrade`, `Proxy-*`, and any header named in `Connection`), every `X-Globalhost-*` header (a namespace reserved for the factory), `Cf-Access-Jwt-Assertion`, `Cf-Access-Authenticated-User-Email` (a direct caller could forge it), and the `CF_Authorization` cookie. Other cookies are kept, and a `Cookie` header that held only the Access cookie is dropped.

Apps get no identity from the guard. A preview that needs a user signs in through its own dev auth (e.g. Firebase test users).

## Health path

`HEALTH_PATH` (default `/__guard/healthz`) is answered by the guard with `200 ok`, with no token required, so Cloud Run startup and liveness probes work. It is never proxied, and it says nothing about the app. Only an exact match on the path before `?` counts: `/__guard/healthz/../x`, `//__guard/healthz`, `/__guard/%68ealthz` and other near misses need a token like any other path.

## Single token path: no cookie

Only the `Cf-Access-Jwt-Assertion` header is accepted, never the `CF_Authorization` cookie. The Worker always forwards the header, so the cookie is never needed. One input path means one thing to get right, and accepting cookies on a `*.run.app` origin would invite CSRF-style questions we don't need to answer. A request carrying only the cookie gets 403.

## Not supported

- **WebSocket and other `Upgrade` requests** get `501 Not Implemented` before any auth or upstream contact. Previews serve production builds, which don't need dev-server HMR sockets. If an app needs WebSockets later, add authenticated upgrade proxying with tests.
- Absolute-form (`GET http://host/…`) and `*` request targets get 400. Request headers over 16 KiB get 431.

## Configuration

Read from the environment at startup. A missing or malformed value logs one `ERROR` line naming the problem and exits 1, so the revision never becomes ready.

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | no (8080) | Port the guard listens on (Cloud Run's ingress port). |
| `UPSTREAM_PORT` | yes | The app container's port on `127.0.0.1`. Must differ from `PORT`. |
| `ACCESS_TEAM_DOMAIN` | yes | Zero Trust team domain, a bare host like `broken-haze-4579.cloudflareaccess.com`. The issuer is `https://<domain>`. |
| `ACCESS_AUD` | yes | One or more comma-separated Access application AUD tags (64 hex characters). |
| `HEALTH_PATH` | no (`/__guard/healthz`) | Absolute path without dot segments, query or percent-encoding. |

On `SIGTERM` the guard stops accepting connections, lets in-flight requests finish for up to 8 s (Cloud Run allows 10 s), then closes what's left.

## Build and run

No runtime dependencies: it uses only `node:http`, `node:crypto` and `fetch`.

```
pnpm --filter @globalhost/access-guard build typecheck test
docker build -f packages/access-guard/Dockerfile -t access-guard .   # from the repo root
```

The image is distroless Node 24, runs as `nonroot`, and contains only the compiled JS. Base images are pinned by digest.
