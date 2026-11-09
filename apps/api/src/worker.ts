import { setTimeout as sleep } from "node:timers/promises";

import { prisma } from "@euthyna/db";

import { loadEnv } from "./env.js";
import { Guard } from "./guard.js";
import { EnvKmsSigner } from "./kms.js";
import { NearClient } from "./near.js";
import { OperationWorker, PrismaWorkerStore } from "./operation-worker.js";
import { createBaseRelayer, createChainRelayers } from "./relayer.js";
import { keepDelegated } from "./delegation-keeper.js";

const env = loadEnv();
const visaSigner = new EnvKmsSigner(
  Uint8Array.from(Buffer.from(env.GUARD_VISA_ED25519_PRIVATE_KEY_BASE64, "base64")),
);
const statusSigner = new EnvKmsSigner(
  Uint8Array.from(Buffer.from(env.GUARD_STATUS_ED25519_PRIVATE_KEY_BASE64, "base64")),
);
const guard = new Guard(visaSigner, statusSigner);
const near = new NearClient(env);
const base = createBaseRelayer(env, near, guard);
const worker = new OperationWorker(
  new PrismaWorkerStore(prisma),
  near,
  base,
  guard,
  {
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    confirmations: env.WORKER_CONFIRMATIONS,
    leaseMs: env.WORKER_LEASE_MS,
    stuckBlocks: env.WORKER_STUCK_BLOCKS,
    broadcastTimeoutMs: env.WORKER_BROADCAST_TIMEOUT_MS,
    retryBaseMs: env.WORKER_RETRY_BASE_MS,
    retryMaxMs: env.WORKER_RETRY_MAX_MS,
    cancellationSenderAccountId: env.NEAR_RELAYER_ACCOUNT_ID,
    agentGasLowYocto: env.NEAR_AGENT_GAS_LOW_YOCTO,
  },
  undefined,
  createChainRelayers(env, near, guard),
);
// Sponsored execution: wallets whose company voted an executor get delegated (EIP-7702). Every vault
// is looked at every 30 s (one view when nothing is voted); a vault on its way (signing, submitted)
// is looked at again on the next round, every 5 s, so a vote is followed within about a minute.
const DELEGATION_SCAN_MS = 30_000;
const DELEGATION_FOLLOW_MS = 5_000;
let delegationScannedAt = 0;
let delegationFollowedAt = 0;
let delegating = new Set<string>();
async function keepWalletsDelegated() {
  const now = Date.now();
  const scan = now - delegationScannedAt >= DELEGATION_SCAN_MS;
  if (!scan && (delegating.size === 0 || now - delegationFollowedAt < DELEGATION_FOLLOW_MS)) return;
  delegationFollowedAt = now;
  if (scan) delegationScannedAt = now;
  const vaults = scan
    ? (await prisma.treasury.findMany({ select: { vaultAccountId: true } })).map((row) => row.vaultAccountId)
    : [...delegating];
  const next = new Set<string>(scan ? [] : delegating);
  for (const vaultAccountId of vaults) {
    const outcome = await keepDelegated(near, base, vaultAccountId, 84532).catch((error: unknown) => `failed: ${String(error).slice(0, 160)}`);
    if (outcome === "signing" || outcome === "submitted") next.add(vaultAccountId);
    else next.delete(vaultAccountId);
    if (outcome !== "none" && outcome !== "delegated") console.log(JSON.stringify({ event: "worker.delegation", vaultAccountId, outcome }));
  }
  delegating = next;
}
let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    running = false;
  });
}

try {
  do {
    try {
      await keepWalletsDelegated().catch((error: unknown) => console.warn(JSON.stringify({ event: "worker.delegation_failed", message: String(error).slice(0, 200) })));
      const result = await worker.tick();
      if (result.processed > 0 || result.adopted > 0) console.log(JSON.stringify({ event: "worker.tick", ...result }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "worker.tick_failed",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    if (process.env.WORKER_ONCE === "1") break;
    await sleep(env.WORKER_POLL_INTERVAL_MS);
  } while (running);
} finally {
  await prisma.$disconnect();
}
