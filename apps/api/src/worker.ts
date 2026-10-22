import { setTimeout as sleep } from "node:timers/promises";

import { prisma } from "@mandateos/db";

import { loadEnv } from "./env.js";
import { Guard } from "./guard.js";
import { EnvKmsSigner } from "./kms.js";
import { NearClient } from "./near.js";
import { OperationWorker, PrismaWorkerStore } from "./operation-worker.js";
import { createBaseRelayer } from "./relayer.js";

const env = loadEnv();
const signer = new EnvKmsSigner(
  Uint8Array.from(Buffer.from(env.GUARD_ED25519_PRIVATE_KEY_BASE64, "base64")),
);
const guard = new Guard(signer);
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
  },
);

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    running = false;
  });
}

try {
  do {
    try {
      const result = await worker.tick();
      if (result.processed > 0) console.log(JSON.stringify({ event: "worker.tick", ...result }));
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
