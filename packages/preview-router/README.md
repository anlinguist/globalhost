# @globalhost/preview-router

Cloudflare Worker that serves PR previews on `*.globalhost.ai` (ADR-0007, ARCHITECTURE §2.6). It runs on the route `*.globalhost.ai/*` behind one Cloudflare Access application, so by the time a request reaches it, Access has already authenticated the caller and added `Cf-Access-Jwt-Assertion`. The Worker only routes. The `access-guard` sidecar on Cloud Run checks that JWT again, so the `*.run.app` URL is not a way around Access.

`pnpm build` emits one import-free ES module, `dist/index.js`. The Pulumi Cloudflare provider uploads that file as the Worker script (module syntax, `export default { fetch }`).

## Routing

Only one label under `globalhost.ai` is served (Universal SSL covers one wildcard level):

| Public host | Origin |
|---|---|
| `<product>-<part>-pr-<n>.globalhost.ai` | `https://pr-<n>---<base host>` (the Cloud Run tagged revision) |
| `<product>-<part>-dev.globalhost.ai` | `https://dev---<base host>` (reserved for a dev tag) |
| anything else: apex, `app.`, deeper levels, other shapes | 404 |

- `product` is `[a-z][a-z0-9-]*`, `part` is `[a-z][a-z0-9]*` (part names have no hyphens, per `factory.yaml`), and `n` is 1 to 7 digits without a leading zero.
- Because products can contain hyphens, the label is parsed from the right: `^(.+)-([a-z][a-z0-9]*)-pr-([1-9][0-9]{0,6})$`. `numu-know-web-pr-12` becomes product `numu-know`, part `web`, PR 12.
- Uppercase, punycode (`xn--`), any `--`, labels over 63 characters and trailing dots are rejected.

The request is proxied with its method, streamed body and headers. The Worker then:

- sets `X-Forwarded-Host` to the public host and `X-Forwarded-Proto: https`. Apps that need their public origin read these, or a per-preview `PUBLIC_ORIGIN`;
- forwards `Cf-Access-Jwt-Assertion` unchanged for `access-guard`, which validates it and strips it before the app sees the request;
- removes the Access session cookies (`CF_Authorization`, `CF_AppSession`, `CF_Binding`) from `Cookie`, because preview code is untrusted and must never see a reusable owner credential. Other cookies pass through;
- deletes Access service-token credentials (`Cf-Access-Client-Id`, `Cf-Access-Client-Secret`, `Cf-Access-Token`) for the same reason;
- strips client-supplied `X-Globalhost-*` (clients can't inject factory headers), `Host`, `Forwarded`, every `X-Forwarded-*` (before setting its own), `X-Real-IP` and `Cf-Access-Authenticated-User-Email`;
- makes every response `Set-Cookie` host-only by dropping its `Domain=` attribute, so one preview can't toss cookies onto sibling previews or other `*.globalhost.ai` hosts. It drops any Access session cookie (`CF_Authorization`, `CF_AppSession`, `CF_Binding`) the origin tries to set. `__Host-`/`__Secure-` cookies keep their other attributes;
- uses `redirect: "manual"` and rewrites any `Location` on the tagged origin host back to the public host;
- passes origin cache headers through but tells Cloudflare not to cache the subrequest (`cf.cacheTtlByStatus` of `-1`);
- adds `X-Robots-Tag: noindex` when the origin didn't set one;
- returns WebSocket upgrades (101) untouched, so the socket passes through.

When Cloud Run has no such tag (the preview isn't deployed yet, or was torn down), its 404 is passed through as-is. An unreachable origin gives a 502.

### Other hosts on the zone

The Worker route `*.globalhost.ai/*` catches every host, and the Worker 404s anything that isn't a preview. When a non-preview host lands (e.g. the PWA at `app.globalhost.ai`), carve it out of the route, either with a more specific route that has no Worker or a separate Worker. Otherwise this router will shadow it.

`app.globalhost.ai` must also get its own Cloudflare Access application, with a separate AUD. A preview-application JWT travels to Cloud Run next to untrusted code, so it must never be accepted by anything else: a separate AUD means a replayed preview JWT fails there.

## The service map

Routes come from one plain-text Worker variable, `PREVIEW_SERVICES`, set by Pulumi:

```json
{ "numu-know-web": "numu-know-web-preview-414694776649.us-central1.run.app" }
```

The key is `<product>-<part>`. The value is the base host of that part's `<part>-preview` Cloud Run service, in either form:

- new deterministic URL: `^[a-z0-9-]+\.[a-z0-9-]+\.run\.app$` (`<service>-<project-number>.<region>.run.app`)
- old URL: `^[a-z0-9-]+-[a-z0-9]+\.a\.run\.app$`

Values that already contain a `---` tag are rejected. Invalid entries are dropped. If the variable is missing or isn't a JSON object, the map is empty and every request 404s, so a bad value fails closed. The map is parsed once per isolate into a `Map` of the JSON's own keys that match `<product>-<part>`, so a key like `__proto__` or `constructor` can't resolve to an inherited value.

### Why there's no KV

Tagged revision URLs are fixed once you know the service's base host. So the Worker can work out the origin for any PR from a static map that changes only when a product or part is added. The preview workflow doesn't write any routes, which keeps a Cloudflare API token out of product CI. Teardown is just removing the Cloud Run tag: after that, the same URL gets Cloud Run's 404.

### Why the origin is validated

The Worker sits behind Access on a wildcard route, so anything it fetches is reachable by an authenticated session with the owner's credentials attached (cookies, the Access JWT). If it followed an arbitrary host, it would become an open proxy, and a bad map value could send the owner's Access JWT to a third party. So the origin host is built only from:

1. a public hostname that matched the strict pattern, and
2. a base host that is provably a `*.run.app` Cloud Run URL.

No path, port, userinfo or scheme ever comes from configuration.

## Develop

```
pnpm --filter @globalhost/preview-router build typecheck test
```

Tests run in Node with a fake `fetch` (`handle(request, env, fetchImpl)` is exported), with no miniflare.
