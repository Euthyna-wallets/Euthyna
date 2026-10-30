# syntax=docker/dockerfile:1.7
# Euthyna Market worker. Build from the repository root:
#   docker build -f apps/market-worker/Dockerfile -t euthyna-market-worker .
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @mandateos/market-worker... \
    && pnpm --filter @mandateos/sdk build

FROM node:22-bookworm-slim
# python3 for the DeFiLlama CLI (stdlib only); bubblewrap and socat for the agent SDK's sandbox.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 bubblewrap socat \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 worker
ENV NODE_ENV=production WORK_DIR=/work HOME=/home/worker
WORKDIR /app
COPY --from=build --chown=root:root /app /app
USER worker
WORKDIR /app/apps/market-worker
CMD ["node", "--import", "tsx", "src/main.ts"]
