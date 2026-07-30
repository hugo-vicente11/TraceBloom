# Multi-stage build for the TraceBloom worker image: the eval runner plus the
# operational CLIs that share its dependency set (Postgres migrations from
# @tracebloom/db, the demo seed/reset CLI). One image, several one-shot or
# long-running commands — the production compose picks the command per service.
# Build context is the repo root (pnpm workspace).

FROM node:24-slim AS base
RUN npm install -g pnpm@11.9.0
WORKDIR /app

# 1. Store from the lockfile only (cache-friendly).
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# 2. Install, build all TS workspace packages the runner needs, then prune the
#    tree down to production dependencies (same lockfile, offline).
FROM deps AS build
COPY . .
# CI=true: the --prod re-install purges dev deps from node_modules without
# prompting (there is no TTY in a docker build).
ENV CI=true
RUN pnpm install --frozen-lockfile --offline \
  && pnpm exec turbo run build --filter=@tracebloom/eval-runner --filter=@tracebloom/demo \
  && pnpm install --prod --frozen-lockfile --offline

# 3. Runtime: the pruned workspace, unprivileged. Compiled entrypoints:
#      node apps/eval-runner/dist/main.js run --watch   (default command)
#      node apps/demo/dist/main.js seed|reset|verify
#      node packages/db/dist/migrate.js
#    No HEALTHCHECK: the runner exposes no port; docker's process supervision
#    plus `restart: unless-stopped` is the meaningful liveness signal.
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app ./
USER node
CMD ["node", "apps/eval-runner/dist/main.js", "run", "--watch"]
