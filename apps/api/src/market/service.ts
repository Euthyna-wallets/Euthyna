/**
 * Euthyna Market gateway: listings, x402 v2 payment requirements, held
 * cheques, task dispatch to the seller's worker, delivery and settlement.
 *
 * Trust model: the gateway never holds funds. It holds a buyer-signed cheque
 * (a NEP-366 delegate of `ft_transfer` to the seller's vault) and relays it
 * once, on delivery. Until then the buyer's tokens stay in the buyer's account.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

import type { PrismaClient } from "@mandateos/db";
import { NEAR_TESTNET_TOKENS } from "@mandateos/sdk/roles";

import { ChequeError, parsePaymentHeader, verifyCheque, X402_VERSION, type ChequeChain, type PaymentRequirement } from "./cheque.js";
import type { ChequeRelayer, FinalTransaction } from "./near-market.js";

export class MarketError extends Error {
  constructor(readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 503, readonly code: string, message: string) {
    super(message);
  }
}

export type MarketConfig = {
  /** CAIP-2-like network id, as market.near.ai: "near:testnet". */
  network: string;
  /** Secret that derives each listing's webhook signing key (never stored per listing). */
  webhookSecret: string;
  /** Settlements the market relayer may pay for per UTC day, in all. */
  dailySettlements: number;
  /** ... and per buyer account, so one buyer cannot use up the day. */
  dailyPerBuyer?: number;
  /** Below this, every settlement logs a warning. */
  relayerLowYocto: bigint;
  /** Extra seconds a cheque must stay valid beyond the listing's SLA. */
  settlementMarginSeconds: number;
};

export type Dispatcher = (url: string, body: string, headers: Record<string, string>) => Promise<void>;

/**
 * POSTs to a webhook, connecting only to the address checked just before:
 * the name is resolved once, every address must be public, and the socket
 * uses that address (TLS still checks the certificate for the name). No
 * redirects are followed. This closes the DNS-rebinding window.
 */
export const pinnedDispatch: Dispatcher = async (url, body, headers) => {
  const target = new URL(url);
  const addresses = await assertPublicWebhook(url);
  const address = addresses[0]!;
  await new Promise<void>((resolve, reject) => {
    const req = request({
      host: target.hostname, servername: target.hostname, port: target.port || 443, path: `${target.pathname}${target.search}`, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
      lookup: (_host, options, callback) => {
        const family = isIP(address);
        if ((options as { all?: boolean }).all) (callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
        else (callback as (error: null, address: string, family: number) => void)(null, address, family);
      },
      timeout: 10_000,
    }, (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      if (status >= 200 && status < 300) resolve();
      else reject(new Error(`webhook HTTP ${status}`));
    });
    req.on("timeout", () => req.destroy(new Error("webhook timeout")));
    req.on("error", reject);
    req.end(body);
  });
};

export const MAX_INPUT_BYTES = 8 * 1024;
export const MAX_RESULT_BYTES = 256 * 1024;
const HANDLE = /^[a-z0-9][a-z0-9-]{2,39}$/;
/** Time a buyer has to send the direct payment of an order. */
export const ORDER_PAYMENT_WINDOW_MS = 15 * 60_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A2A task states, as the protocol spells them. */
export function a2aState(state: string): string {
  return ({
    awaiting_payment: "TASK_STATE_AUTH_REQUIRED",
    submitted: "TASK_STATE_SUBMITTED",
    working: "TASK_STATE_WORKING",
    completed: "TASK_STATE_COMPLETED",
    completed_unpaid: "TASK_STATE_COMPLETED",
    failed: "TASK_STATE_FAILED",
    expired: "TASK_STATE_FAILED",
  } as Record<string, string>)[state] ?? "TASK_STATE_UNKNOWN";
}

/**
 * Webhooks go to the seller's own server: https, a public host, never an IP
 * literal or a private address (no requests into our network).
 */
export async function assertPublicWebhook(url: string, resolve: (host: string) => Promise<string[]> = async (host) => (await lookup(host, { all: true })).map((item) => item.address)): Promise<string[]> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MarketError(400, "invalid_webhook", "webhook is not a URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new MarketError(400, "invalid_webhook", "webhook must be https, without credentials");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) || /^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new MarketError(400, "invalid_webhook", "webhook host must be a public domain name");
  const addresses = await resolve(host).catch(() => []);
  if (addresses.length === 0 || addresses.some(privateAddress)) throw new MarketError(400, "invalid_webhook", "webhook host must resolve to public addresses only");
  return addresses;
}

export function privateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith("::ffff:")) return privateAddress(lower.slice(7));
    // Loopback, unspecified, unique-local, link-local, NAT64, 6to4, Teredo, documentation, multicast.
    return lower === "::1" || lower === "::" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("64:ff9b:")
      || lower.startsWith("2002:") || lower.startsWith("2001:0:") || lower.startsWith("2001:db8:") || lower.startsWith("ff");
  }
  const [a, b, c] = address.split(".").map(Number) as [number, number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
}

export class MarketService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly chain: ChequeChain,
    private readonly relayer: ChequeRelayer,
    private readonly config: MarketConfig,
    private readonly dispatch: Dispatcher = pinnedDispatch,
    private readonly now: () => Date = () => new Date(),
    private readonly storageRegistered: (token: string, accountId: string) => Promise<boolean> = async () => true,
    private readonly readTransaction: (txHash: string, senderId: string) => Promise<FinalTransaction | null> = async () => null,
  ) {}

  // -------------------------------------------------------------------------
  // Direct payment, for wallets that cannot sign delegate actions (no escrow)
  // -------------------------------------------------------------------------

  /** Opens an order: the buyer pays it with a plain ft_transfer whose memo names it, within 15 minutes. */
  async order(handle: string, buyer: string, input: string) {
    const listing = await this.live(handle);
    if (!/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(buyer) || buyer.length < 2 || buyer.length > 64) throw new MarketError(400, "invalid_buyer", "buyer must be a NEAR account id");
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) throw new MarketError(413, "input_too_large", "task input is limited to 8 KiB");
    if (!input.trim()) throw new MarketError(400, "empty_input", "the task has no text");
    if (!(await this.buyerCapacityLeft(buyer))) throw new MarketError(409, "buyer_daily_limit", "this account reached today's purchase limit");
    const open = await this.prisma.marketTask.count({ where: { buyerAccountId: buyer, state: "awaiting_payment", expiresAt: { gt: this.now() } } });
    if (open >= 3) throw new MarketError(409, "too_many_open_orders", "pay or let expire your open orders first");
    const task = await this.prisma.marketTask.create({
      data: { listingId: listing.id, buyerAccountId: buyer, input, state: "awaiting_payment", expiresAt: new Date(this.now().getTime() + ORDER_PAYMENT_WINDOW_MS) },
    });
    return { taskId: task.id, payBefore: task.expiresAt.toISOString(), payment: this.orderPayment(listing, task.id) };
  }

  orderPayment(listing: { asset: string; priceAtomic: string; payTo: string }, taskId: string) {
    return {
      receiverId: listing.asset,
      methodName: "ft_transfer",
      args: { receiver_id: listing.payTo, amount: listing.priceAtomic, memo: `market:${taskId}` },
      deposit: "1",
      gas: "30000000000000",
    };
  }

  /**
   * The buyer says it paid: the transaction must be final and successful, from
   * the buyer, one ft_transfer on the asset with exactly the order's terms,
   * and never used before. Then the task goes to the worker.
   */
  async confirmOrder(taskId: string, txHash: string) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash)) throw new MarketError(400, "invalid_tx", "txHash must be a NEAR transaction hash");
    const task = await this.prisma.marketTask.findUnique({ where: { id: taskId }, include: { listing: true } });
    if (!task || task.state !== "awaiting_payment") throw new MarketError(409, "not_awaiting_payment", "this order is not waiting for a payment");
    if (task.expiresAt <= this.now()) throw new MarketError(409, "order_expired", "the payment window closed; open a new order");
    const tx = await this.readTransaction(txHash, task.buyerAccountId);
    if (!tx) throw new MarketError(409, "tx_not_final", "the transaction is not final yet (or unknown); retry in a few seconds");
    const expected = this.orderPayment(task.listing, task.id);
    const [action] = tx.actions;
    let args: unknown = null;
    try {
      args = JSON.parse(Buffer.from(action?.args ?? "", "base64").toString("utf8"));
    } catch { /* checked below */ }
    const paid = args as Record<string, unknown> | null;
    if (!tx.succeeded || tx.signerId !== task.buyerAccountId || tx.receiverId !== expected.receiverId || tx.actions.length !== 1 || action?.methodName !== "ft_transfer"
      || !paid || paid.receiver_id !== expected.args.receiver_id || paid.amount !== expected.args.amount || paid.memo !== expected.args.memo) {
      throw new MarketError(402, "payment_mismatch", `the transaction must be a successful ft_transfer from ${task.buyerAccountId} on ${expected.receiverId} of ${expected.args.amount} to ${expected.args.receiver_id} with memo ${expected.args.memo}`);
    }
    try {
      await this.prisma.$transaction(async (db) => {
        const moved = await db.marketTask.updateMany({ where: { id: taskId, state: "awaiting_payment" }, data: { state: "submitted", expiresAt: new Date(this.now().getTime() + task.listing.slaSeconds * 1000) } });
        if (moved.count !== 1) throw new MarketError(409, "not_awaiting_payment", "this order is not waiting for a payment");
        // Already paid: the "hold" records the transfer; there is nothing to relay.
        await db.paymentHold.create({
          data: {
            taskId, signedDelegateB64: "", delegateHash: `tx:${txHash}`, sender: task.buyerAccountId, publicKey: "", nonce: "0", maxBlockHeight: "0",
            amount: expected.args.amount, asset: expected.receiverId, payTo: expected.args.receiver_id, state: "prepaid", settleTxHash: txHash, settledAt: this.now(),
          },
        });
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") throw new MarketError(409, "tx_used", "this transaction already paid an order");
      throw error;
    }
    const listing = task.listing;
    const fresh = await this.task(taskId);
    void this.notify(listing, fresh).catch(() => undefined);
    return fresh;
  }

  // -------------------------------------------------------------------------
  // Listings (company members)
  // -------------------------------------------------------------------------

  async createListing(organizationId: string, payTo: string, input: {
    handle: string; title: string; description: string; category?: string | undefined; price: string; asset?: string | undefined;
    slaSeconds?: number | undefined; inputHint?: string | undefined; outputHint?: string | undefined; agentId?: string | null | undefined; webhookUrl?: string | null | undefined;
  }) {
    if (!HANDLE.test(input.handle)) throw new MarketError(400, "invalid_handle", "handle: 3-40 lowercase letters, digits or dashes");
    const token = NEAR_TESTNET_TOKENS.find((item) => item.symbol === (input.asset ?? "USDC") || item.accountId === input.asset);
    if (!token) throw new MarketError(400, "invalid_asset", "unknown NEAR token");
    const priceAtomic = toAtomic(input.price, token.decimals);
    if (input.agentId) {
      const agent = await this.prisma.agent.findFirst({ where: { id: input.agentId, organizationId } });
      if (!agent) throw new MarketError(404, "agent_not_found", "agent not found in this company");
    }
    if (input.webhookUrl) await assertPublicWebhook(input.webhookUrl);
    if (await this.prisma.marketListing.findUnique({ where: { handle: input.handle } })) throw new MarketError(409, "handle_taken", "this handle is taken");
    return this.prisma.marketListing.create({
      data: {
        organizationId, handle: input.handle, title: input.title, description: input.description, category: input.category ?? "research",
        priceAtomic, asset: token.accountId, payTo, slaSeconds: input.slaSeconds ?? 1800,
        inputHint: input.inputHint ?? "", outputHint: input.outputHint ?? "", agentId: input.agentId ?? null, webhookUrl: input.webhookUrl ?? null,
      },
    });
  }

  /** The handle and the payee never change; going live needs a worker token and a payee registered on the token. */
  async updateListing(organizationId: string, id: string, input: {
    title?: string | undefined; description?: string | undefined; category?: string | undefined; price?: string | undefined; slaSeconds?: number | undefined;
    inputHint?: string | undefined; outputHint?: string | undefined; status?: "draft" | "live" | "paused" | undefined; webhookUrl?: string | null | undefined;
  }) {
    const listing = await this.ownListing(organizationId, id);
    const decimals = NEAR_TESTNET_TOKENS.find((item) => item.accountId === listing.asset)?.decimals ?? 6;
    if (input.webhookUrl) await assertPublicWebhook(input.webhookUrl);
    if (input.status === "live") {
      if (!listing.deliveryTokenHash) throw new MarketError(409, "no_worker", "create a delivery token for the worker first");
      if (!(await this.storageRegistered(listing.asset, listing.payTo))) {
        throw new MarketError(409, "payee_not_registered", `${listing.payTo} is not registered on the token: vote a role with NEAR transfers (it registers the vault) first`);
      }
    }
    const { price, ...rest } = input;
    const data = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
    return this.prisma.marketListing.update({ where: { id }, data: { ...data, ...(price ? { priceAtomic: toAtomic(price, decimals) } : {}) } });
  }

  /** New delivery token (shown once) and the webhook signing key derived for this listing. */
  async rotateDeliveryToken(organizationId: string, id: string) {
    await this.ownListing(organizationId, id);
    const token = `mdt_${randomBytes(32).toString("base64url")}`;
    await this.prisma.marketListing.update({ where: { id }, data: { deliveryTokenHash: sha256(token) } });
    return { deliveryToken: token, webhookSecret: this.webhookKey(id) };
  }

  async listings(organizationId: string) {
    const listings = await this.prisma.marketListing.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" } });
    return listings.map(({ deliveryTokenHash, ...listing }) => ({ ...listing, hasDeliveryToken: Boolean(deliveryTokenHash) }));
  }

  async sales(organizationId: string) {
    const tasks = await this.prisma.marketTask.findMany({
      where: { listing: { organizationId } },
      include: { hold: true, listing: { select: { handle: true, title: true, asset: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const rows = tasks.map((task) => ({
      taskId: task.id, handle: task.listing.handle, title: task.listing.title, buyer: task.buyerAccountId, state: task.state,
      amount: task.hold?.amount ?? null, asset: task.listing.asset, holdState: task.hold?.state ?? null, settleTxHash: task.hold?.settleTxHash ?? null,
      createdAt: task.createdAt.toISOString(), completedAt: task.completedAt?.toISOString() ?? null,
    }));
    const revenue = rows.filter((row) => row.holdState === "settled" || row.holdState === "prepaid").reduce((sum, row) => sum + BigInt(row.amount ?? "0"), 0n);
    return { sales: rows, revenueAtomic: revenue.toString() };
  }

  /** What these accounts (a company's agents and their cards) bought. */
  async purchases(buyers: string[]) {
    if (buyers.length === 0) return { purchases: [], spentAtomic: "0" };
    const tasks = await this.prisma.marketTask.findMany({
      where: { buyerAccountId: { in: buyers }, state: { not: "awaiting_payment" } },
      include: { hold: true, listing: { select: { handle: true, title: true, asset: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const rows = tasks.map((task) => ({
      taskId: task.id, handle: task.listing.handle, title: task.listing.title, buyer: task.buyerAccountId, state: task.state,
      amount: task.hold?.amount ?? null, asset: task.listing.asset, holdState: task.hold?.state ?? null, settleTxHash: task.hold?.settleTxHash ?? null,
      createdAt: task.createdAt.toISOString(), completedAt: task.completedAt?.toISOString() ?? null,
    }));
    const spent = rows.filter((row) => row.holdState === "settled" || row.holdState === "prepaid").reduce((sum, row) => sum + BigInt(row.amount ?? "0"), 0n);
    return { purchases: rows, spentAtomic: spent.toString() };
  }

  // -------------------------------------------------------------------------
  // Public catalog, agent cards, x402
  // -------------------------------------------------------------------------

  requirement(listing: { asset: string; priceAtomic: string; payTo: string; slaSeconds: number }): PaymentRequirement {
    return { scheme: "exact", network: this.config.network, asset: listing.asset, amount: listing.priceAtomic, payTo: listing.payTo, maxTimeoutSeconds: listing.slaSeconds + this.config.settlementMarginSeconds };
  }

  paymentRequired(listing: Parameters<MarketService["requirement"]>[0], error = "x-payment header is required") {
    return { x402Version: X402_VERSION, error, accepts: [this.requirement(listing)] };
  }

  async catalog(query?: string) {
    const listings = await this.prisma.marketListing.findMany({
      where: { status: "live", ...(query ? { OR: [{ title: { contains: query, mode: "insensitive" } }, { description: { contains: query, mode: "insensitive" } }, { handle: { contains: query.toLowerCase() } }] } : {}) },
      include: { organization: { select: { name: true } } },
      take: 100,
    });
    // Counts in the database, not task rows in memory.
    const ids = listings.map((listing) => listing.id);
    const counts = ids.length ? await this.prisma.marketTask.groupBy({ by: ["listingId", "state"], where: { listingId: { in: ids } }, _count: { _all: true } }) : [];
    const ratings = ids.length ? await this.prisma.marketRating.findMany({ where: { task: { listingId: { in: ids } } }, select: { stars: true, task: { select: { listingId: true } } }, take: 10_000 }) : [];
    return listings.map((listing) => {
      const count = (states: string[]) => counts.filter((row) => row.listingId === listing.id && states.includes(row.state)).reduce((sum, row) => sum + row._count._all, 0);
      const finished = count(["completed", "completed_unpaid", "failed", "expired"]);
      const delivered = count(["completed"]);
      const stars = ratings.filter((rating) => rating.task.listingId === listing.id).map((rating) => rating.stars);
      return {
        handle: listing.handle, title: listing.title, description: listing.description, category: listing.category, seller: listing.organization.name,
        price: listing.priceAtomic, asset: listing.asset, symbol: NEAR_TESTNET_TOKENS.find((item) => item.accountId === listing.asset)?.symbol ?? null,
        payTo: listing.payTo, slaSeconds: listing.slaSeconds, inputHint: listing.inputHint, outputHint: listing.outputHint,
        delivered, successRate: finished ? delivered / finished : null,
        rating: stars.length ? stars.reduce((a, b) => a + b, 0) / stars.length : null,
      };
    });
  }

  async live(handle: string) {
    const listing = await this.prisma.marketListing.findUnique({ where: { handle } });
    if (!listing || listing.status !== "live") throw new MarketError(404, "listing_not_found", "no live listing with this handle");
    return listing;
  }

  async agentCard(handle: string, baseUrl: string) {
    const listing = await this.live(handle);
    return {
      name: listing.title,
      description: listing.description,
      url: `${baseUrl}/a2a/${listing.handle}/v1`,
      version: "1.0.0",
      protocolVersion: "1.0",
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/markdown", "application/json"],
      skills: [{ id: listing.handle, name: listing.title, description: listing.description, tags: [listing.category], examples: listing.inputHint ? [listing.inputHint] : [] }],
      // How to pay: x402 v2 on NEAR, the cheque goes to the seller's vault.
      payment: { x402Version: X402_VERSION, accepts: [this.requirement(listing)] },
    };
  }

  async x402Recipients() {
    const listings = await this.prisma.marketListing.findMany({ where: { status: "live" } });
    return { x402Version: X402_VERSION, recipients: listings.map((listing) => ({ handle: listing.handle, ...this.requirement(listing) })) };
  }

  // -------------------------------------------------------------------------
  // Buying: cheque in, task out
  // -------------------------------------------------------------------------

  /**
   * Verifies the cheque, then holds it and creates the task atomically. The
   * delegate hash is unique in the database, so two concurrent submissions of
   * the same cheque cannot both create a task.
   */
  async submit(handle: string, paymentHeader: string | undefined, input: string) {
    const listing = await this.live(handle);
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) throw new MarketError(413, "input_too_large", "task input is limited to 8 KiB");
    if (!input.trim()) throw new MarketError(400, "empty_input", "the message has no text");
    if (!paymentHeader) return { paymentRequired: this.paymentRequired(listing) };
    if (!(await this.settlementCapacityLeft())) throw new MarketError(503, "settlement_capacity", "the market cannot settle more payments today; try tomorrow");
    const requirement = this.requirement(listing);
    let cheque;
    try {
      cheque = await verifyCheque(parsePaymentHeader(paymentHeader), requirement, this.chain, async (hash) => Boolean(await this.prisma.paymentHold.findUnique({ where: { delegateHash: hash } })));
    } catch (error) {
      if (error instanceof ChequeError) return { paymentRequired: { ...this.paymentRequired(listing, `${error.code}: ${error.message}`) } };
      throw error;
    }
    const now = this.now();
    if (!(await this.buyerCapacityLeft(cheque.senderId))) return { paymentRequired: this.paymentRequired(listing, "buyer_daily_limit: this account reached today's purchase limit") };
    const openKey = `${cheque.senderId}:${cheque.publicKey}`;
    if (await this.prisma.paymentHold.findUnique({ where: { openKey } })) {
      return { paymentRequired: this.paymentRequired(listing, "cheque_open: this key already has an unsettled cheque; wait for it to settle") };
    }
    try {
      const task = await this.prisma.$transaction(async (tx) => {
        const created = await tx.marketTask.create({
          data: { listingId: listing.id, buyerAccountId: cheque.senderId, input, expiresAt: new Date(now.getTime() + listing.slaSeconds * 1000) },
        });
        await tx.paymentHold.create({
          data: {
            taskId: created.id, signedDelegateB64: cheque.signedDelegateB64, delegateHash: cheque.delegateHash, sender: cheque.senderId, openKey,
            publicKey: cheque.publicKey, nonce: cheque.nonce.toString(), maxBlockHeight: cheque.maxBlockHeight.toString(),
            amount: requirement.amount, asset: requirement.asset, payTo: requirement.payTo,
          },
        });
        return created;
      });
      void this.notify(listing, task).catch(() => undefined);
      return { task };
    } catch (error) {
      // A unique index refused it: the same cheque, or a second open cheque of one key, raced in.
      if ((error as { code?: string }).code === "P2002") return { paymentRequired: this.paymentRequired(listing, "replayed: this cheque (or another open cheque of this key) is already held") };
      throw error;
    }
  }

  async task(id: string) {
    const task = await this.prisma.marketTask.findUnique({ where: { id }, include: { hold: true, listing: { select: { handle: true, title: true } } } });
    if (!task) throw new MarketError(404, "task_not_found", "no task with this id");
    return task;
  }

  /** Wait (bounded) for a task to finish, for the synchronous A2A answer. */
  async waitFor(id: string, timeoutMs: number, pollMs = 1_000) {
    const deadline = Date.now() + timeoutMs;
    let task = await this.task(id);
    while (["submitted", "working"].includes(task.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      task = await this.task(id);
    }
    return task;
  }

  // -------------------------------------------------------------------------
  // Worker side (delivery token)
  // -------------------------------------------------------------------------

  async workerListing(authorization: string | undefined) {
    const token = authorization?.match(/^Bearer (mdt_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new MarketError(401, "unauthorized", "Bearer mdt_ delivery token required");
    const listing = await this.prisma.marketListing.findUnique({ where: { deliveryTokenHash: sha256(token) } });
    const expected = listing?.deliveryTokenHash ? Buffer.from(listing.deliveryTokenHash, "hex") : Buffer.alloc(32);
    if (!listing || !timingSafeEqual(expected, Buffer.from(sha256(token), "hex"))) throw new MarketError(401, "unauthorized", "unknown delivery token");
    return listing;
  }

  async assigned(listingId: string) {
    const tasks = await this.prisma.marketTask.findMany({ where: { listingId, state: { in: ["submitted", "working"] }, expiresAt: { gt: this.now() } }, orderBy: { createdAt: "asc" }, take: 20 });
    return tasks.map((task) => ({ id: task.id, state: task.state, input: task.input, buyer: task.buyerAccountId, createdAt: task.createdAt.toISOString(), expiresAt: task.expiresAt.toISOString() }));
  }

  async start(listingId: string, taskId: string) {
    const updated = await this.prisma.marketTask.updateMany({ where: { id: taskId, listingId, state: "submitted", expiresAt: { gt: this.now() } }, data: { state: "working", startedAt: this.now() } });
    if (updated.count !== 1) throw new MarketError(409, "not_startable", "the task is not waiting to start (or has expired)");
    return this.task(taskId);
  }

  async fail(listingId: string, taskId: string, reason: string) {
    // Not after a delivery: a delivered task is settled, not failed.
    const updated = await this.prisma.marketTask.updateMany({ where: { id: taskId, listingId, state: { in: ["submitted", "working"] }, resultMarkdown: null }, data: { state: "failed", failureReason: reason.slice(0, 500), completedAt: this.now() } });
    if (updated.count !== 1) throw new MarketError(409, "not_open", "the task is already finished");
    // The cheque is never relayed: the buyer pays nothing for a failed task.
    await this.prisma.paymentHold.updateMany({ where: { taskId, state: "held" }, data: { state: "expired", settleError: "task failed", openKey: null } });
    return this.task(taskId);
  }

  /**
   * Stores the result, then relays the cheque exactly once. The hold moves
   * held -> settling in a single conditional update: a second delivery (or a
   * concurrent one) finds nothing to claim and relays nothing.
   */
  async deliver(listingId: string, taskId: string, result: { markdown: string; json?: unknown; files?: unknown }) {
    if (Buffer.byteLength(result.markdown, "utf8") > MAX_RESULT_BYTES) throw new MarketError(413, "result_too_large", "results are limited to 256 KiB of markdown");
    const now = this.now();
    const stored = await this.prisma.marketTask.updateMany({
      // resultMarkdown: null makes the first delivery the only one, even when two race.
      where: { id: taskId, listingId, state: { in: ["submitted", "working"] }, expiresAt: { gt: now }, resultMarkdown: null },
      data: { resultMarkdown: result.markdown, resultJson: (result.json ?? undefined) as never, files: (result.files ?? undefined) as never, completedAt: now },
    });
    if (stored.count !== 1) throw new MarketError(409, "not_deliverable", "the task is not open (finished, failed or expired)");
    return this.settle(taskId);
  }

  async settle(taskId: string) {
    const claimed = await this.prisma.paymentHold.updateMany({ where: { taskId, state: "held" }, data: { state: "settling" } });
    const hold = await this.prisma.paymentHold.findUnique({ where: { taskId } });
    // Paid upfront (direct transfer): delivering completes the task.
    if (hold?.state === "prepaid") {
      await this.prisma.marketTask.updateMany({ where: { id: taskId, state: { in: ["submitted", "working"] } }, data: { state: "completed" } });
      return this.task(taskId);
    }
    if (claimed.count !== 1 || !hold) {
      // Delivered after the cheque expired: the result stays, unpaid.
      if (hold && (hold.state === "expired" || hold.state === "failed")) {
        await this.prisma.marketTask.updateMany({ where: { id: taskId, state: { in: ["submitted", "working"] }, resultMarkdown: { not: null } }, data: { state: "completed_unpaid" } });
      }
      return this.task(taskId);
    }
    const outcome = await this.relayer.relay(hold.signedDelegateB64, hold.sender);
    await this.prisma.paymentHold.update({
      where: { taskId },
      data: outcome.ok
        ? { state: "settled", settleTxHash: outcome.txHash, settledAt: this.now(), openKey: null }
        : { state: "failed", settleTxHash: outcome.txHash, settleError: outcome.error, openKey: null },
    });
    // Unpaid: the buyer spent the balance or the key meanwhile. The seller keeps the record.
    await this.prisma.marketTask.update({ where: { id: taskId }, data: { state: outcome.ok ? "completed" : "completed_unpaid" } });
    if (!outcome.ok) console.warn(`market: cheque for task ${taskId} from ${hold.sender} was not paid: ${outcome.error}`);
    await this.warnIfRelayerLow();
    return this.task(taskId);
  }

  /** Holds past their block height and tasks past their deadline expire; no cheque is relayed for them. */
  async expire() {
    const height = await this.chain.blockHeight();
    const now = this.now();
    await this.prisma.marketTask.updateMany({ where: { state: "awaiting_payment", expiresAt: { lte: now } }, data: { state: "expired", completedAt: now } });
    const late = await this.prisma.marketTask.findMany({ where: { state: { in: ["submitted", "working"] }, expiresAt: { lte: now } }, select: { id: true } });
    for (const task of late) {
      await this.prisma.marketTask.updateMany({ where: { id: task.id, state: { in: ["submitted", "working"] } }, data: { state: "expired", completedAt: now } });
      await this.prisma.paymentHold.updateMany({ where: { taskId: task.id, state: "held" }, data: { state: "expired", settleError: "not delivered in time", openKey: null } });
    }
    const held = await this.prisma.paymentHold.findMany({ where: { state: "held" }, select: { id: true, taskId: true, maxBlockHeight: true } });
    const deadHolds = held.filter((hold) => BigInt(hold.maxBlockHeight) < height);
    const dead = deadHolds.map((hold) => hold.id);
    if (dead.length) {
      await this.prisma.paymentHold.updateMany({ where: { id: { in: dead }, state: "held" }, data: { state: "expired", settleError: "cheque expired on chain", openKey: null } });
      // Nobody would pay for them any more: their tasks stop too.
      await this.prisma.marketTask.updateMany({ where: { id: { in: deadHolds.map((hold) => hold.taskId) }, state: { in: ["submitted", "working"] } }, data: { state: "expired", completedAt: now } });
    }
    return { expiredTasks: late.length, expiredHolds: dead.length };
  }

  // -------------------------------------------------------------------------

  private async ownListing(organizationId: string, id: string) {
    const listing = await this.prisma.marketListing.findFirst({ where: { id, organizationId } });
    if (!listing) throw new MarketError(404, "listing_not_found", "listing not found in this company");
    return listing;
  }

  webhookKey(listingId: string): string {
    return createHmac("sha256", this.config.webhookSecret).update(`market-webhook:${listingId}`).digest("hex");
  }

  /** Signs `${timestamp}.${body}` so the worker can reject stale or forged pushes. */
  signWebhook(listingId: string, body: string, timestamp: string): string {
    return `sha256=${createHmac("sha256", this.webhookKey(listingId)).update(`${timestamp}.${body}`).digest("hex")}`;
  }

  private async notify(listing: { id: string; handle: string; webhookUrl: string | null; slaSeconds: number }, task: { id: string; input: string; createdAt: Date; expiresAt: Date }) {
    if (!listing.webhookUrl) return;
    const body = JSON.stringify({ type: "market.task.created", task: { id: task.id, handle: listing.handle, input: task.input, createdAt: task.createdAt.toISOString(), expiresAt: task.expiresAt.toISOString() } });
    for (const [attempt, delay] of [0, 1_000, 4_000, 16_000].entries()) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        // The dispatcher checks the name again and connects to the checked address.
        const timestamp = Math.floor(Date.now() / 1000).toString();
        await this.dispatch(listing.webhookUrl, body, { "x-euthyna-signature": this.signWebhook(listing.id, body, timestamp), "x-euthyna-timestamp": timestamp });
        return;
      } catch (error) {
        if (attempt === 3) console.warn(`market: webhook for ${listing.handle} failed after retries: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async settlementCapacityLeft(): Promise<boolean> {
    const day = new Date(this.now());
    day.setUTCHours(0, 0, 0, 0);
    const today = await this.prisma.paymentHold.count({ where: { createdAt: { gte: day } } });
    return today < this.config.dailySettlements;
  }

  private async buyerCapacityLeft(sender: string): Promise<boolean> {
    const day = new Date(this.now());
    day.setUTCHours(0, 0, 0, 0);
    const today = await this.prisma.paymentHold.count({ where: { sender, createdAt: { gte: day } } });
    return today < (this.config.dailyPerBuyer ?? 20);
  }

  private async warnIfRelayerLow() {
    const balance = await this.relayer.balanceYocto().catch(() => null);
    if (balance !== null && balance < this.config.relayerLowYocto) console.warn(`market: relayer ${this.relayer.accountId} is low on NEAR (${balance} yocto)`);
  }
}

/** "2.5" -> "2500000" for 6 decimals; refuses zero, negatives and extra precision. */
export function toAtomic(amount: string, decimals: number): string {
  const match = amount.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || (match[2]?.length ?? 0) > decimals) throw new MarketError(400, "invalid_price", `price must be a positive amount with at most ${decimals} decimals`);
  const atomic = BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt((match[2] ?? "").padEnd(decimals, "0") || "0");
  if (atomic <= 0n) throw new MarketError(400, "invalid_price", "price must be positive");
  return atomic.toString();
}
