# access-guard: Cloudflare Access JWT check in front of a Cloud Run preview app.
# Build from the repo root:
#   docker build -f packages/access-guard/Dockerfile -t access-guard .
#
# Base images are pinned by multi-arch index digest (resolved 2026-11-01 with
# `docker buildx imagetools inspect`); Renovate bumps them.

# --- build: compile TypeScript with the workspace's locked toolchain ---
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build
WORKDIR /src
# corepack fetches the pnpm version (and checks the sha512) pinned in package.json#packageManager.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/access-guard/package.json packages/access-guard/
# Root devDependencies (typescript, @types/node) only; the guard has no runtime deps.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter globalhost --filter @globalhost/access-guard
COPY packages/access-guard/tsconfig.json packages/access-guard/tsconfig.build.json packages/access-guard/
COPY packages/access-guard/src packages/access-guard/src
RUN pnpm --filter @globalhost/access-guard build \
 && find packages/access-guard/dist -type f ! -name '*.js' -delete

# --- runtime: distroless Node 24, non-root, compiled JS only ---
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/packages/access-guard/package.json ./package.json
COPY --from=build /src/packages/access-guard/dist ./dist
USER nonroot
EXPOSE 8080
# The distroless entrypoint is node; this is the script it runs.
CMD ["dist/main.js"]
