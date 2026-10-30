/**
 * The gateway against a real PostgreSQL (TEST_DATABASE_URL), with the chain
 * and the relayer faked: holds, tasks, replay, settlement and expiry.
 */
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@mandateos/db";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MemoryRateLimiter } from "../rate-limit.js";
import type { ChequeChain } from "./cheque.js";
import type { ChequeRelayer, RelayOutcome } from "./near-market.js";
import { registerMarketPublicRoutes, registerMarketWorkerRoutes } from "./routes.js";
import { MarketError, MarketService } from "./service.js";
import { BUYER, buyerKey, cheque, USDC, VAULT, type Overrides } from "./test-cheque.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("market gateway (PostgreSQL)", () => {
  // Built only when the suite runs: describe bodies execute even when skipped.
  const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : ({} as PrismaClient);
  let organizationId: string;
  let handle: string;
  let height = 1_000n;
  let relays: string[] = [];
  let relayResult: RelayOutcome = { ok: true, txHash: "settle-tx" };
  let balance = 10_000_000n;
  const chain: ChequeChain = {
    accessKey: async (accountId, publicKey) => (accountId === BUYER && publicKey === buyerKey.getPublicKey().toString() ? { nonce: 100n, permission: "FullAccess" } : null),
    blockHeight: async () => height,
    ftBalance: async () => balance,
  };
  const relayer: ChequeRelayer = {
    accountId: "market-relayer.testnet",
    relay: async (b64) => {
      relays.push(b64);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return relayResult;
    },
    balanceYocto: async () => 10n ** 25n,
  };
  const pushes: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  // Direct payments: transactions the fake chain knows, by hash.
  const transactions = new Map<string, import("./near-market.js").FinalTransaction>();
  const market = new MarketService(prisma, chain, relayer, {
    network: "near:testnet", webhookSecret: "x".repeat(40), dailySettlements: 1000, relayerLowYocto: 1n, settlementMarginSeconds: 600,
  }, async (url, body, headers) => { pushes.push({ url, body, headers }); }, undefined, async () => true,
  async (hash, sender) => { const tx = transactions.get(hash); return tx && tx.signerId === sender ? tx : null; });
  const transfer = (taskId: string, overrides: Partial<{ amount: string; to: string; memo: string; signer: string; succeeded: boolean; token: string }> = {}) => ({
    signerId: overrides.signer ?? BUYER, receiverId: overrides.token ?? USDC, succeeded: overrides.succeeded ?? true,
    actions: [{ methodName: "ft_transfer", deposit: "1", args: Buffer.from(JSON.stringify({ receiver_id: overrides.to ?? VAULT, amount: overrides.amount ?? "2000000", memo: overrides.memo ?? `market:${taskId}` })).toString("base64") }],
  });
  const hash = () => (randomUUID().replace(/-/g, "") + "11111111111").replace(/[0OIl]/g, "1").slice(0, 44);
  const json = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const app = new Hono();
  // As in the API: market errors are JSON with their status.
  app.onError((error, context) => (error instanceof MarketError ? context.json({ error: error.code, message: error.message }, error.status) : context.json({ error: String(error) }, 500)));
  registerMarketPublicRoutes(app, market, { baseUrl: "https://api.euthyna.test", limiter: new MemoryRateLimiter(10_000, 60_000), syncWaitMs: 200 });
  registerMarketWorkerRoutes(app, market, new MemoryRateLimiter(10_000, 60_000));
  let deliveryToken: string;

  // Each cheque is new: the same key and nonce would be a replay, across tests too.
  let nonce = BigInt(Date.now());
  const nextNonce = () => (nonce += 1n);
  const header = async (o: Overrides = {}, accepted?: Record<string, unknown>) => {
    const listing = await prisma.marketListing.findUniqueOrThrow({ where: { handle } });
    const payment = { x402Version: 2, accepted: accepted ?? market.requirement(listing), payload: { signedDelegateAction: await cheque({ maxBlockHeight: 10_000n, nonce: nextNonce(), ...o }) } };
    return Buffer.from(JSON.stringify(payment)).toString("base64");
  };
  const send = (payment?: string, text = "Due diligence on aave-v3") => app.request(`/a2a/${handle}/v1`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(payment ? { "x-payment": payment } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "user", parts: [{ kind: "text", text }] } } }),
  });
  const worker = (path: string, body?: unknown) => app.request(path, {
    method: body === undefined && path.endsWith("assigned") ? "GET" : "POST",
    headers: { authorization: `Bearer ${deliveryToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  beforeAll(async () => {
    organizationId = randomUUID();
    await prisma.organization.create({ data: { id: organizationId, name: "Acme AI", slug: `acme-${organizationId.slice(0, 8)}`, createdAt: new Date() } });
  });
  afterAll(async () => {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    handle = `dd-${randomUUID().slice(0, 8)}`;
    relays = [];
    relayResult = { ok: true, txHash: "settle-tx" };
    balance = 10_000_000n;
    height = 1_000n;
    // Tests share the buyer key: close cheques earlier tests left open.
    await prisma.paymentHold.updateMany({ where: { sender: BUYER }, data: { openKey: null } });
    const listing = await market.createListing(organizationId, VAULT, { handle, title: "DeFi due diligence", description: "A sourced report on a DeFi project.", price: "2", slaSeconds: 1800 });
    deliveryToken = (await market.rotateDeliveryToken(organizationId, listing.id)).deliveryToken;
    await market.updateListing(organizationId, listing.id, { status: "live" });
  });

  it("answers 402 with the same shape as market.near.ai, the network aside", async () => {
    const response = await send();
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({
      x402Version: 2,
      error: "x-payment header is required",
      accepts: [{ scheme: "exact", network: "near:testnet", asset: USDC, amount: "2000000", payTo: VAULT, maxTimeoutSeconds: 2400 }],
    });
  });

  it("holds a good cheque, refuses it a second time, and runs the task once", async () => {
    const payment = await header();
    const first = await send(payment);
    expect(first.status).toBe(200);
    const body = await first.json() as { result: { id: string; status: { state: string } } };
    expect(body.result.status.state).toBe("TASK_STATE_SUBMITTED");
    const again = await send(payment);
    expect(again.status).toBe(402);
    expect(((await again.json()) as { error: string }).error).toMatch(/^replayed/);
    expect(await prisma.marketTask.count({ where: { listing: { handle } } })).toBe(1);
  });

  it("lets only one of two concurrent submissions of the same cheque through", async () => {
    const payment = await header();
    const results = await Promise.all([send(payment), send(payment), send(payment)]);
    expect(results.filter((response) => response.status === 200)).toHaveLength(1);
    expect(await prisma.paymentHold.count({ where: { task: { listing: { handle } } } })).toBe(1);
  });

  it("holds one open cheque per buyer key: a second one cannot be paid in order, so it waits", async () => {
    expect((await send(await header())).status).toBe(200);
    const second = await send(await header());
    expect(second.status).toBe(402);
    expect(((await second.json()) as { error: string }).error).toMatch(/^cheque_open/);
  });

  it("refuses forged cheques with a precise 402", async () => {
    const forged = [
      [await header({ args: { receiver_id: VAULT, amount: "1" } }), /^wrong_transfer/],
      [await header({ args: { receiver_id: "attacker.testnet", amount: "2000000" } }), /^wrong_transfer/],
      [await header({}, { scheme: "exact", network: "near:testnet", asset: USDC, amount: "1", payTo: VAULT, maxTimeoutSeconds: 2400 }), /^requirement_mismatch/],
      [await header({ maxBlockHeight: 1_100n }), /^expires_too_soon/],
    ] as const;
    for (const [payment, error] of forged) {
      const response = await send(payment);
      expect(response.status).toBe(402);
      expect(((await response.json()) as { error: string }).error).toMatch(error);
    }
    expect(await prisma.marketTask.count({ where: { listing: { handle } } })).toBe(0);
  });

  it("delivers, relays the cheque exactly once, and returns the result", async () => {
    const created = await (await send(await header())).json() as { result: { id: string } };
    const id = created.result.id;
    const assigned = await (await worker("/v1/market/tasks/assigned")).json() as { tasks: Array<{ id: string; input: string }> };
    expect(assigned.tasks).toEqual([expect.objectContaining({ id, input: "Due diligence on aave-v3" })]);
    expect((await worker(`/v1/market/tasks/${id}/start`, {})).status).toBe(200);
    const deliveries = await Promise.all([1, 2, 3].map(() => worker(`/v1/market/tasks/${id}/deliver`, { markdown: "# Report", json: { verdict: "neutral" } })));
    expect(deliveries.filter((response) => response.status === 200)).toHaveLength(1);
    expect(relays).toHaveLength(1);
    const hold = await prisma.paymentHold.findUniqueOrThrow({ where: { taskId: id } });
    expect(hold).toMatchObject({ state: "settled", settleTxHash: "settle-tx" });
    const task = await (await app.request(`/a2a/${handle}/v1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id } }) })).json() as { result: { status: { state: string }; artifacts: Array<{ parts: Array<{ text?: string; data?: unknown }> }>; metadata: { payment: { state: string } } } };
    expect(task.result.status.state).toBe("TASK_STATE_COMPLETED");
    expect(task.result.artifacts[0]!.parts).toEqual([expect.objectContaining({ text: "# Report" }), expect.objectContaining({ data: { verdict: "neutral" } })]);
    expect(task.result.metadata.payment.state).toBe("settled");
  });

  it("marks the task delivered but unpaid when the cheque bounces", async () => {
    relayResult = { ok: false, txHash: null, error: "NotEnoughBalance" };
    const { result } = await (await send(await header())).json() as { result: { id: string } };
    await worker(`/v1/market/tasks/${result.id}/deliver`, { markdown: "# Report" });
    expect(await prisma.marketTask.findUniqueOrThrow({ where: { id: result.id } })).toMatchObject({ state: "completed_unpaid" });
    // Unpaid: the buyer does not get the result.
    const view = await (await app.request(`/a2a/${handle}/v1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "GetTask", params: { id: result.id } }) })).json() as { result: { artifacts: unknown[]; status: { message: string } } };
    expect(view.result.artifacts).toEqual([]);
    expect(view.result.status.message).toMatch(/withheld/);
    expect(await prisma.paymentHold.findUniqueOrThrow({ where: { taskId: result.id } })).toMatchObject({ state: "failed", settleError: "NotEnoughBalance" });
  });

  it("never relays the cheque of a failed or expired task", async () => {
    const failed = (await (await send(await header())).json() as { result: { id: string } }).result.id;
    expect((await worker(`/v1/market/tasks/${failed}/fail`, { reason: "source down" })).status).toBe(200);
    expect((await worker(`/v1/market/tasks/${failed}/deliver`, { markdown: "late" })).status).toBe(409);
    const late = (await (await send(await header())).json() as { result: { id: string } }).result.id;
    await prisma.marketTask.update({ where: { id: late }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await market.expire()).expiredTasks).toBeGreaterThanOrEqual(1);
    expect((await worker(`/v1/market/tasks/${late}/deliver`, { markdown: "late" })).status).toBe(409);
    expect(relays).toHaveLength(0);
    expect((await prisma.paymentHold.findMany({ where: { taskId: { in: [failed, late] } } })).map((hold) => hold.state)).toEqual(["expired", "expired"]);
  });

  it("expires holds whose cheque died on chain", async () => {
    const { result } = await (await send(await header())).json() as { result: { id: string } };
    height = 11_000n;
    expect((await market.expire()).expiredHolds).toBeGreaterThanOrEqual(1);
    expect(await prisma.paymentHold.findUniqueOrThrow({ where: { taskId: result.id } })).toMatchObject({ state: "expired" });
    expect(await prisma.marketTask.findUniqueOrThrow({ where: { id: result.id } })).toMatchObject({ state: "expired" });
    expect((await worker(`/v1/market/tasks/${result.id}/deliver`, { markdown: "late" })).status).toBe(409);
    expect(relays).toHaveLength(0);
  });

  it("only lets the listing's own worker touch its tasks", async () => {
    const { result } = await (await send(await header())).json() as { result: { id: string } };
    const other = await market.createListing(organizationId, VAULT, { handle: `${handle}-x`, title: "Other", description: "Another listing here.", price: "1" });
    const otherToken = (await market.rotateDeliveryToken(organizationId, other.id)).deliveryToken;
    const response = await app.request(`/v1/market/tasks/${result.id}/deliver`, { method: "POST", headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" }, body: JSON.stringify({ markdown: "stolen" }) });
    expect(response.status).toBe(409);
    expect((await app.request("/v1/market/tasks/assigned", { headers: { authorization: "Bearer mdt_wrong" } })).status).toBe(401);
    expect(relays).toHaveLength(0);
  });

  it("publishes the agent card and the x402 recipients", async () => {
    const card = await (await app.request(`/a2a/${handle}/.well-known/agent-card.json`)).json() as { url: string; payment: { accepts: unknown[] } };
    expect(card.url).toBe(`https://api.euthyna.test/a2a/${handle}/v1`);
    expect(card.payment.accepts).toHaveLength(1);
    const recipients = await (await app.request("/.well-known/x402")).json() as { recipients: Array<{ handle: string; payTo: string }> };
    expect(recipients.recipients).toContainEqual(expect.objectContaining({ handle, payTo: VAULT }));
  });

  it("direct payment: an order, a matching transfer, then the worker; the transfer cannot pay twice", async () => {
    const order = await (await json("/v1/market/orders", { handle, buyer: BUYER, input: "Due diligence on curve" })).json() as { taskId: string; payment: { receiverId: string; args: { receiver_id: string; amount: string; memo: string } } };
    expect(order.payment).toMatchObject({ receiverId: USDC, args: { receiver_id: VAULT, amount: "2000000", memo: `market:${order.taskId}` } });
    // Not visible to the worker before it is paid.
    expect(((await (await worker("/v1/market/tasks/assigned")).json()) as { tasks: unknown[] }).tasks).toEqual([]);
    const wrong = [transfer(order.taskId, { amount: "1" }), transfer(order.taskId, { to: "attacker.testnet" }), transfer(order.taskId, { memo: "market:other" }), transfer(order.taskId, { succeeded: false }), transfer(order.taskId, { token: "usdc.fakes.testnet" })];
    for (const tx of wrong) {
      const h = hash();
      transactions.set(h, tx);
      expect((await json(`/v1/market/orders/${order.taskId}/paid`, { txHash: h })).status).toBe(402);
    }
    const unknown = await json(`/v1/market/orders/${order.taskId}/paid`, { txHash: hash() });
    expect(unknown.status).toBe(409);
    const good = hash();
    transactions.set(good, transfer(order.taskId));
    const paid = await json(`/v1/market/orders/${order.taskId}/paid`, { txHash: good });
    expect(paid.status).toBe(200);
    expect(((await paid.json()) as { task: { status: { state: string } } }).task.status.state).toBe("TASK_STATE_SUBMITTED");
    // The same transaction cannot pay another order.
    const other = await (await json("/v1/market/orders", { handle, buyer: BUYER, input: "Another one" })).json() as { taskId: string };
    expect((await json(`/v1/market/orders/${other.taskId}/paid`, { txHash: good })).status).toBe(402);
    // Worker delivers; nothing is relayed, the result is released.
    await worker(`/v1/market/tasks/${order.taskId}/deliver`, { markdown: "# Curve report" });
    expect(relays).toHaveLength(0);
    const view = await (await app.request(`/v1/market/tasks/${order.taskId}`)).json() as { task: { status: { state: string }; artifacts: Array<{ parts: Array<{ text?: string }> }>; metadata: { payment: { state: string } } } };
    expect(view.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(view.task.artifacts[0]!.parts[0]!.text).toBe("# Curve report");
    expect(view.task.metadata.payment.state).toBe("prepaid");
  });

  it("direct payment: expired orders cannot be paid, and buyers cannot pile up open orders", async () => {
    const order = await (await json("/v1/market/orders", { handle, buyer: BUYER, input: "late" })).json() as { taskId: string };
    await prisma.marketTask.update({ where: { id: order.taskId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const h = hash();
    transactions.set(h, transfer(order.taskId));
    expect((await json(`/v1/market/orders/${order.taskId}/paid`, { txHash: h })).status).toBe(409);
    await prisma.marketTask.updateMany({ where: { buyerAccountId: BUYER, state: "awaiting_payment" }, data: { state: "expired" } });
    for (let i = 0; i < 3; i += 1) expect((await json("/v1/market/orders", { handle, buyer: BUYER, input: `o${i}` })).status).toBe(201);
    expect((await json("/v1/market/orders", { handle, buyer: BUYER, input: "o4" })).status).toBe(409);
    await prisma.marketTask.updateMany({ where: { buyerAccountId: BUYER, state: "awaiting_payment" }, data: { state: "expired" } });
  });
});
