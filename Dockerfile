# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS workspace

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

ARG VITE_API_URL=""
ARG VITE_NEAR_RPC_URL=https://rpc.testnet.fastnear.com
ARG VITE_BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
ARG VITE_ETHEREUM_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
ARG VITE_WALLETCONNECT_PROJECT_ID=""
ARG VITE_MANDATEOS_REGISTRY_ID=euthyna-directory.testnet
ARG VITE_MANDATEOS_PREVIOUS_REGISTRY_IDS=atlantis-registry.testnet
ARG VITE_EUTHYNA_RECOVERY_ID=euthyna-recovery-v4.testnet
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_NEAR_RPC_URL=$VITE_NEAR_RPC_URL
ENV VITE_BASE_SEPOLIA_RPC_URL=$VITE_BASE_SEPOLIA_RPC_URL
ENV VITE_ETHEREUM_SEPOLIA_RPC_URL=$VITE_ETHEREUM_SEPOLIA_RPC_URL
ENV VITE_WALLETCONNECT_PROJECT_ID=$VITE_WALLETCONNECT_PROJECT_ID
ENV VITE_MANDATEOS_REGISTRY_ID=$VITE_MANDATEOS_REGISTRY_ID
ENV VITE_MANDATEOS_PREVIOUS_REGISTRY_IDS=$VITE_MANDATEOS_PREVIOUS_REGISTRY_IDS
ENV VITE_EUTHYNA_RECOVERY_ID=$VITE_EUTHYNA_RECOVERY_ID

RUN pnpm build

FROM node:22-bookworm-slim AS runtime

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate

WORKDIR /app
COPY --from=workspace /app /app

CMD ["node", "apps/api/dist/server.js"]

FROM caddy:2.9-alpine AS console

COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=workspace /app/apps/console/dist /srv
