# Multi-stage build for the TraceBloom dashboard (Next.js, standalone output).
# Build context is the repo root so the pnpm workspace (lockfile + local
# packages the dashboard depends on) is available.

FROM node:24-slim AS base
# Hard-pin pnpm to the workspace's packageManager version (no corepack: it is
# deprecated in Node 24 and slated for removal).
RUN npm install -g pnpm@11.9.0
WORKDIR /app

# 1. Populate the pnpm store from the lockfile only — this layer is reused
#    across builds until the lockfile changes.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# 2. Build the dashboard and its workspace dependencies (turbo handles ^build
#    ordering), emitting the self-contained standalone server.
FROM deps AS build
COPY . .
RUN pnpm install --frozen-lockfile --offline
# Canonical public origin, baked in for absolute OG/canonical URLs (NEXT_PUBLIC_*
# is inlined at build time). Empty arg → the app's compiled-in default applies.
ARG NEXT_PUBLIC_SITE_URL=""
ENV NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
RUN pnpm exec turbo run build --filter=@tracebloom/dashboard

# 3. Runtime: only the traced standalone output, run as the unprivileged node
#    user. The standalone tree mirrors the monorepo layout (tracing root is the
#    repo root), so the server entry lives at apps/dashboard/server.js.
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=build --chown=node:node /app/apps/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/dashboard/.next/static ./apps/dashboard/.next/static

USER node
EXPOSE 3000
# Liveness only (/api/health has no dependencies); dependency health is a
# separate concern surfaced by /api/status.
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/dashboard/server.js"]
