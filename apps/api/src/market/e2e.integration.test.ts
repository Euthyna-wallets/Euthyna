/**
 * The market end to end, with nothing faked but the clock: a NEAR sandbox,
 * PostgreSQL, the real euthyna-signer holding the buyer's card, the gateway,
 * the seller's worker (tx-check) and the market relayer.
 *
 *   TEST_DATABASE_URL=… NEAR_SANDBOX_RPC=… NEAR_SANDBOX_KEY_FILE=… EUTHYNA_SIGNER_BIN=… vitest run src/market/e2e
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { serve } from "@hono/node-server";
import { PrismaClient } from "@mandateos/db";
import { MarketBuyer, nearRpc, SignerCard, SignerSocket } from "@mandateos/sdk";
import { Hono } from "hono";
import { KeyPair, keyStores, Near, utils } from "near-api-js";
import { encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import { afterAll, describe, expect, it } from "vitest";

import { MarketApi } from "../../../market-worker/src/api.js";
import { txCheckJob } from "../../../market-worker/src/jobs/tx-check.js";
import { runTask } from "../../../market-worker/src/main.js";
import { MemoryRateLimiter } from "../rate-limit.js";
import { chequeChain, NearChequeRelayer, storageRegistered } from "./near-market.js";
import { registerMarketPublicRoutes, registerMarketWorkerRoutes } from "./routes.js";
import { MarketError, MarketService } from "./service.js";

const env = { db: process.env.TEST_DATABASE_URL, rpc: process.env.NEAR_SANDBOX_RPC, keyFile: process.env.NEAR_SANDBOX_KEY_FILE, bin: process.env.EUTHYNA_SIGNER_BIN };

describe.skipIf(!env.db || !env.rpc || !env.keyFile || !env.bin)("market end to end (sandbox, PostgreSQL, real signer)", () => {
  const cleanup: Array<() => void> = [];
  afterAll(() => cleanup.forEach((step) => step()));

  it("an agent hires another company's agent, pays from its card on delivery, and gets the result", async () => {
    // --- Chain: a token, the seller's vault account, the buyer's card, the market relayer.
    const validator = JSON.parse(readFileSync(env.keyFile!, "utf8")) as { account_id: string; secret_key?: string; private_key?: string };
    const root = validator.account_id;
    const rootKey = KeyPair.fromString((validator.secret_key ?? validator.private_key) as `ed25519:${string}`);
    const tag = Date.now().toString(36);
    const ids = { ft: `ft-${tag}.${root}`, vault: `seller-${tag}.${root}`, card: `buyer-${tag}-card.${root}`, relayer: `market-${tag}.${root}` };
    const relayerKey = KeyPair.fromRandom("ed25519");
    const keyStore = new keyStores.InMemoryKeyStore();
    for (const id of [root, ids.ft, ids.vault]) await keyStore.setKey("sandbox", id, rootKey);
    const near = new Near({ networkId: "sandbox", nodeUrl: env.rpc!, keyStore });
    const admin = await near.account(root);
    const NEAR = 10n ** 24n;
    await admin.createAccount(ids.ft, rootKey.getPublicKey(), 10n * NEAR);
    const ft = await near.account(ids.ft);
    await ft.deployContract(readFileSync(resolve(import.meta.dirname, "../../../../contracts/res/test_ft.wasm")));
    await ft.functionCall({ contractId: ids.ft, methodName: "new", args: {} });
    await admin.createAccount(ids.vault, rootKey.getPublicKey(), NEAR);
    await admin.createAccount(ids.relayer, relayerKey.getPublicKey(), 5n * NEAR);
    await ft.functionCall({ contractId: ids.ft, methodName: "mint", args: { account_id: ids.vault, amount: "0" } });

    // --- The buyer's euthyna-signer, holding the card key (made here, never exported).
    const dir = mkdtempSync(join(tmpdir(), "e2e-signer-"));
    const state = join(dir, "state");
    mkdirSync(join(state, "agents"), { recursive: true, mode: 0o700 });
    const seed = utils.serialize.base_encode(crypto.getRandomValues(new Uint8Array(32)));
    const agent = `buyer-${tag}-agent.${root}`;
    const recordPath = join(state, "agents", `${agent}.json`);
    writeFileSync(recordPath, JSON.stringify({
      account_id: agent, network_id: "sandbox", vault_id: ids.vault, allowed_methods: ["prepare"], max_gas: 300000000000000, max_deposit_yocto: "1",
      secret_seed: utils.serialize.base_encode(crypto.getRandomValues(new Uint8Array(32))),
      card: { account_id: ids.card, token: ids.ft, max_per_payment: "5000000", secret_seed: seed },
    }));
    chmodSync(recordPath, 0o600);
    const socketPath = join(dir, "signer.sock");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ socket_path: socketPath, allowed_uids: [process.getuid!()], state_dir: state, audit_log: join(dir, "audit.log"), rate_per_minute: 100 }));
    const daemon: ChildProcess = spawn(env.bin!, ["--config", join(dir, "config.json"), "serve"], { stdio: "ignore" });
    cleanup.push(() => daemon.kill());
    const socket = new SignerSocket(socketPath);
    for (let i = 0; i < 50 && !(await socket.request({ op: "status" }).then(() => true, () => false)); i += 1) await new Promise((r) => setTimeout(r, 100));
    const card = new SignerCard(socket, agent);
    const cardInfo = await card.info();
    // As the API would: the card account is created with the signer's public key, then refilled.
    await admin.createAccount(ids.card, cardInfo.publicKey, NEAR / 100n);
    await ft.functionCall({ contractId: ids.ft, methodName: "mint", args: { account_id: ids.card, amount: "5000000" } });
    await new Promise((r) => setTimeout(r, 3_000)); // reads are at finality "final"

    // --- Gateway and seller's listing.
    const prisma = new PrismaClient({ datasources: { db: { url: env.db! } } });
    cleanup.push(() => void prisma.$disconnect());
    const rpc = nearRpc(env.rpc!);
    const market = new MarketService(prisma, chequeChain(rpc), new NearChequeRelayer(ids.relayer, relayerKey.toString(), "sandbox", env.rpc!), {
      network: "near:sandbox", webhookSecret: "w".repeat(40), dailySettlements: 100, relayerLowYocto: 0n, settlementMarginSeconds: 600,
    }, async () => undefined, undefined, (token, account) => storageRegistered(rpc, token, account));
    const app = new Hono();
    app.onError((error, c) => (error instanceof MarketError ? c.json({ error: error.code, message: error.message }, error.status) : c.json({ error: String(error) }, 500)));
    registerMarketPublicRoutes(app, market, { baseUrl: "http://127.0.0.1:3917", limiter: new MemoryRateLimiter(1000, 60_000), syncWaitMs: 20_000 });
    registerMarketWorkerRoutes(app, market, new MemoryRateLimiter(1000, 60_000));
    const server = serve({ fetch: app.fetch, port: 3917 });
    cleanup.push(() => server.close());
    const org = randomUUID();
    await prisma.organization.create({ data: { id: org, name: "Seller AI", slug: `seller-${org.slice(0, 8)}`, createdAt: new Date() } });
    cleanup.push(() => void prisma.organization.delete({ where: { id: org } }).catch(() => undefined));
    const handle = `tx-${tag}`;
    const listing = await market.createListing(org, ids.vault, { handle, title: "Check a transaction", description: "Plain-English check of an EVM call.", price: "2", asset: "USDC", slaSeconds: 300 });
    // The test token stands in for USDC here: point the listing at it.
    await prisma.marketListing.update({ where: { id: listing.id }, data: { asset: ids.ft } });
    const { deliveryToken } = await market.rotateDeliveryToken(org, listing.id);
    await market.updateListing(org, listing.id, { status: "live" });

    // --- Seller's worker, polling.
    const worker = new MarketApi("http://127.0.0.1:3917", deliveryToken);
    let stop = false;
    const loop = (async () => {
      while (!stop) {
        const { tasks } = await worker.assigned().catch(() => ({ tasks: [] }));
        for (const task of tasks) await runTask(worker, task, async (t) => txCheckJob(t.input), 10_000);
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
    cleanup.push(() => { stop = true; });

    // --- The buyer agent hires it (what the MCP tool hire_agent does).
    const buyer = new MarketBuyer("http://127.0.0.1:3917", card, rpc);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: ["0x1111111111111111111111111111111111111111", maxUint256] });
    const balance = async (account: string) => BigInt(await ft.viewFunction({ contractId: ids.ft, methodName: "ft_balance_of", args: { account_id: account } }) as string);
    const hired = await buyer.hire({ handle, task: JSON.stringify({ chainId: 84532, to: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", data }), maxPriceAtomic: 3_000_000n });
    expect(hired.outcome).toBe("hired");
    let task = (hired as { task: { id: string; status: { state: string } } }).task;
    for (let i = 0; i < 40 && task.status.state !== "TASK_STATE_COMPLETED"; i += 1) {
      await new Promise((r) => setTimeout(r, 1_000));
      task = await buyer.status(handle, task.id) as typeof task;
    }
    stop = true;
    await loop;
    const done = await buyer.status(handle, task.id);
    expect(done.status.state).toBe("TASK_STATE_COMPLETED");
    expect(done.artifacts[0]!.parts[0]!.text).toMatch(/Unlimited approval/);
    expect(await balance(ids.vault)).toBe(2_000_000n);
    expect(await balance(ids.card)).toBe(3_000_000n);
    const hold = await prisma.paymentHold.findUniqueOrThrow({ where: { taskId: task.id } });
    expect(hold.state).toBe("settled");

    // A second purchase above max_price is refused before anything is signed.
    await expect(buyer.hire({ handle, task: "x", maxPriceAtomic: 1_000_000n })).resolves.toMatchObject({ outcome: "refused" });
  }, 180_000);
});
