import { setTimeout as sleep } from "node:timers/promises";

import { prisma } from "@euthyna/db";

import { loadEnv } from "./env.js";
import { Guard } from "./guard.js";
import { EnvKmsSigner } from "./kms.js";
import { NearClient } from "./near.js";
import { OperationWorker, PrismaWorkerStore } from "./operation-worker.js";
import { createBaseRelayer, createChainRelayers } from "./relayer.js";
import { keepDelegated } from "./delegation-keeper.js";
import { followCompanies } from "./chain-follower.js";
import { vaultNotices } from "./vault-notices.js";
import { SolanaFollower } from "./solana-follower.js";
import { solanaRpc } from "@euthyna/sdk/solana";

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
    // The API's rule keeper: a rule the vault refused while this payment held its role is tried now.
    onFinished: (vaultAccountId) => notices?.publish(vaultAccountId, "settled"),
  },
  undefined,
  createChainRelayers(env, near, guard),
);
// Sponsored execution: wallets whose company voted an executor get delegated (EIP-7702). A vault is
// looked at when something happens on it (a notice: the vote's rule ran), then every 5 s while it
// is on its way (signing, submitted). Every vault is also looked at on a timer: once an hour with
// notices on, every 30 s without (one view when nothing is voted).
const DELEGATION_SCAN_MS = 30_000;
const NOTIFIED_DELEGATION_SCAN_MS = 60 * 60_000;
const DELEGATION_FOLLOW_MS = 5_000;
let delegationScannedAt = 0;
let delegationFollowedAt = 0;
let delegating = new Set<string>();
/**
 * Vaults with a notice, and until when they are looked at: an RPC node's final block can be a
 * little behind the transaction that caused the notice, so one look right away is not enough.
 */
const TOUCH_FOLLOW_MS = 20_000;
const touchedVaults = new Map<string, number>();
const notices = vaultNotices(env, prisma);
// Solana transfers followed to the end, agent online or not: settled when final, freed when lost.
const solana = new SolanaFollower(
  near,
  solanaRpc(env.SOLANA_RPC_URL),
  env.NEAR_TX_INDEXER_URL ?? (env.NEAR_NETWORK_ID === "mainnet" ? "https://tx.main.fastnear.com" : "https://tx.test.fastnear.com"),
);
const SOLANA_SWEEP_MS = 60 * 60_000;
let solanaSweptAt = 0;
const solanaWallets = new Map<string, boolean>();
async function hasSolanaWallet(vault: string): Promise<boolean> {
  if (solanaWallets.get(vault)) return true;
  const wallet = await near.viewFunction<{ address: number[] | null } | null>(vault, "get_solana_wallet").catch(() => null);
  const has = Boolean(wallet?.address);
  solanaWallets.set(vault, has);
  return has;
}
async function followSolana() {
  const now = Date.now();
  if (now - solanaSweptAt >= SOLANA_SWEEP_MS) {
    solanaSweptAt = now;
    for (const { vaultAccountId } of await prisma.treasury.findMany({ select: { vaultAccountId: true } })) {
      if (await hasSolanaWallet(vaultAccountId)) await solana.scan(vaultAccountId).catch(() => undefined);
    }
  }
  await solana.tick();
}
if (notices) {
  notices.subscribe((vault, reason) => {
    if (reason === "agent" || reason === "rule" || reason === "block") {
      void hasSolanaWallet(vault).then((has) => (has ? solana.scan(vault) : undefined)).catch(() => undefined);
    }
    // Its own notices (a payment it settled) concern the API's jobs, not these.
    if (reason === "settled" || reason === "delegation" || reason === "recovery") return;
    touchedVaults.set(vault, Date.now() + TOUCH_FOLLOW_MS);
    worker.notice(vault);
  });
  worker.withNotices(() => true);
}
// Optional: a block feed, for what does not pass through this server (chain-follower.ts).
followCompanies(
  env,
  prisma,
  () => prisma.treasury.findMany({ select: { vaultAccountId: true, daoAccountId: true } }),
  {
    touch: (vault) => notices?.publish(vault, "block"),
    gap: () => { delegationScannedAt = 0; worker.noticeGap(); },
  },
);
async function keepWalletsDelegated() {
  const now = Date.now();
  for (const [vault, until] of touchedVaults) {
    delegating.add(vault);
    if (until <= now) touchedVaults.delete(vault);
  }
  const scan = now - delegationScannedAt >= (notices ? NOTIFIED_DELEGATION_SCAN_MS : DELEGATION_SCAN_MS);
  if (!scan && (delegating.size === 0 || now - delegationFollowedAt < DELEGATION_FOLLOW_MS)) return;
  delegationFollowedAt = now;
  if (scan) delegationScannedAt = now;
  const vaults = scan
    ? (await prisma.treasury.findMany({ select: { vaultAccountId: true } })).map((row) => row.vaultAccountId)
    : [...delegating];
  const next = new Set<string>(scan ? [] : delegating);
  for (const vaultAccountId of vaults) {
    const outcome = await keepDelegated(near, base, vaultAccountId, 84532).catch((error: unknown) => `failed: ${String(error).slice(0, 160)}`);
    // A failed look (an RPC error) is tried again on the next round: the timer no longer comes back in 30 s.
    if (outcome === "signing" || outcome === "submitted" || outcome.startsWith("failed")) next.add(vaultAccountId);
    else next.delete(vaultAccountId);
    if (outcome !== "none" && outcome !== "delegated") console.log(JSON.stringify({ event: "worker.delegation", vaultAccountId, outcome }));
    // The console's screens: "Sponsored" shows without waiting for their cache.
    if (outcome === "submitted") notices?.publish(vaultAccountId, "delegation");
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
      await followSolana().catch((error: unknown) => console.warn(JSON.stringify({ event: "worker.solana_sweep_failed", message: String(error).slice(0, 200) })));
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
