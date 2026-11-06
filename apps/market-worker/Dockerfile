# syntax=docker/dockerfile:1.7
# Euthyna Market worker. Build from the repository root:
#   docker build -f apps/market-worker/Dockerfile -t euthyna-market-worker .
#
# Three stages so the shipped image carries production dependencies and the
# compiled worker only: the production server has a 9 GB disk, and a 1.9 GB
# worker on top of the 2.8 GB app image left no room for Postgres.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @euthyna/market-worker... \
    && pnpm --filter @euthyna/sdk build \
    && pnpm --filter @euthyna/market-worker build

# Production dependencies only, resolved from the lockfile.
FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/market-worker/package.json apps/market-worker/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN pnpm install --prod --frozen-lockfile --filter @euthyna/market-worker...

FROM node:22-bookworm-slim
# python3 for the DeFiLlama CLI (stdlib only); bubblewrap and socat for the agent SDK's sandbox.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 bubblewrap socat \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 worker
ENV NODE_ENV=production WORK_DIR=/work HOME=/home/worker
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/market-worker/node_modules ./apps/market-worker/node_modules
COPY --from=deps /app/packages/sdk/node_modules ./packages/sdk/node_modules
COPY --from=deps /app/apps/market-worker/package.json ./apps/market-worker/package.json
COPY --from=deps /app/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=build /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /app/apps/market-worker/dist ./apps/market-worker/dist
COPY apps/market-worker/skills ./apps/market-worker/skills
COPY apps/market-worker/docker-entrypoint.sh ./apps/market-worker/docker-entrypoint.sh
# The host umask may strip read access (package.json came out 600 once); the worker
# runs as an unprivileged user, so make the tree readable and the script executable.
RUN chmod 0755 /app/apps/market-worker/docker-entrypoint.sh
USER worker
WORKDIR /app/apps/market-worker
CMD ["node", "dist/main.js"]
