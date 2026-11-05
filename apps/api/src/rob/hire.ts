/**
 * Rob the Agent, « Can't rob him? Hire him. »: the player buys Ruggy's real service on the
 * Euthyna Market (listing `tx-check` of Rob the Agent Co., 1 TestUSDC, paid to the Rob vault)
 * from the same throwaway key, with a held cheque released on delivery.
 *
 * - Top-up (`POST /v1/rob/hire/topup`): Ruggy's full key creates the key's implicit account,
 *   registers it on the test token and mints it the price. Once per key and once per client
 *   (salted address hash), a daily cap for everyone; each step is recorded, a retry resumes.
 * - Terms (`POST /v1/rob/hire/terms`): the key's nonce and a final block height, what the browser
 *   needs (with the 402 from the A2A endpoint) to sign the cheque itself (`@mandateos/sdk/cheque`).
 * - Delivery: no worker container. The API polls its own market worker endpoints in-process
 *   (`app.request`, the listing's delivery token) and runs the same tx-check as apps/market-worker
 *   (`@mandateos/sdk/tx-check`). Delivering goes through MarketService.deliver, so the cheque is
 *   relayed by the market relayer exactly as for any seller.
 *
 * The buyer pays no gas: the market relayer sends the delegate, the account needs no NEAR.
 */
import type { Hono } from "hono";
import { z } from "zod";

import { prisma } from "@mandateos/db";
import { txCheckJob } from "@mandateos/sdk/tx-check";

import { robHireSettings, type RobHireSettings } from "../env.js";
import { clientIp } from "../market/routes.js";
import { MemoryRateLimiter, type RateLimiter } from "../rate-limit.js";
import type { RobExtrasContext } from "./extras.js";
import type { Outcome, RobAction } from "./near-tx.js";
import { RobError, RobService } from "./service.js";

/** The listing's price, and so the top-up: 1 TestUSDC (6 decimals). */
export const HIRE_PRICE_ATOMIC = 1_000_000n;
/** NEP-145 minimum on the test token, if its storage_balance_bounds cannot be read. */
const DEFAULT_STORAGE_YOCTO = "1250000000000000000000";
const ED25519 = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const NEARBLOCKS = "https://testnet.nearblocks.io/txns/";

type TopupRow = { publicKey: string; account: string; clientHash: string; state: string; createTx: string | null; registerTx: string | null; mintTx: string | null; createdAt: Date };
type TopupSteps = Pick<TopupRow, "createTx" | "registerTx" | "mintTx">;

/** The top-up table (a Prisma client fits). */
export interface HireStore {
  robHireTopup: {
    findUnique(args: { where: { publicKey: string } }): Promise<TopupRow | null>;
    count(args: { where: { createdAt: { gte: Date }; clientHash?: string } }): Promise<number>;
    create(args: { data: { publicKey: string; account: string; clientHash: string } }): Promise<TopupRow>;
    update(args: { where: { publicKey: string }; data: Partial<TopupSteps> & { state?: string } }): Promise<TopupRow>;
  };
}

type Rpc = { call<T>(method: string, params: unknown): Promise<T>; view<T>(accountId: string, methodName: string, args?: Record<string, unknown>, finality?: "optimistic" | "final"): Promise<T> };

/** What hire needs from the game: its accounts, its RPC, Ruggy's full key (RobService.asRuggy()). */
export type HireDesk = {
  config: { ruggyAccountId: string; vaultAccountId: string; token: string };
  rpc: Rpc;
  send(receiverId: string, actions: RobAction[]): Promise<Outcome>;
};

const missing = (error: unknown) => /UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|does not exist|AccessKeyDoesNotExist/i.test(String(error instanceof Error ? error.message : error));

export class RobHire {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly desk: HireDesk,
    private readonly store: HireStore,
    private readonly settings: Pick<RobHireSettings, "ROB_HIRE_HANDLE" | "ROB_HIRE_DAILY_TOPUPS" | "ROB_HIRE_TOPUPS_PER_CLIENT" | "ROB_HIRE_ACCOUNT_YOCTO">,
    private readonly now: () => number = Date.now,
  ) {}

  private account(publicKey: string): string {
    if (!ED25519.test(publicKey)) throw new RobError(400, "invalid_key", "publicKey must be an ed25519 key, ed25519:<base58>");
    return RobService.attackerOf(publicKey);
  }

  /** What the browser needs to sign the cheque: the key's nonce (null before the top-up) and a final height. */
  async terms(publicKey: string) {
    const account = this.account(publicKey);
    const [key, block, balance, topup] = await Promise.all([
      this.desk.rpc.call<{ nonce: number | string }>("query", { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey })
        .catch((error: unknown) => { if (missing(error)) return null; throw error; }),
      this.desk.rpc.call<{ header: { height: number } }>("block", { finality: "final" }),
      this.balance(account),
      this.store.robHireTopup.findUnique({ where: { publicKey } }),
    ]);
    return {
      handle: this.settings.ROB_HIRE_HANDLE,
      a2a: `/a2a/${this.settings.ROB_HIRE_HANDLE}/v1`,
      account,
      vault: this.desk.config.vaultAccountId,
      token: this.desk.config.token,
      price: HIRE_PRICE_ATOMIC.toString(),
      nonce: key ? String(key.nonce) : null,
      blockHeight: String(block.header.height),
      balance: balance.toString(),
      toppedUp: topup?.state === "done",
    };
  }

  /** At finality final, as the market gateway reads it: an optimistic balance lets the page send a cheque the gateway refuses. */
  private async balance(account: string): Promise<bigint> {
    try {
      return BigInt(await this.desk.rpc.view<string>(this.desk.config.token, "ft_balance_of", { account_id: account }, "final"));
    } catch (error) {
      if (missing(error)) return 0n;
      throw error;
    }
  }

  /** One top-up per key: concurrent calls for one key wait for the first. */
  async topup(publicKey: string, clientHash: string) {
    const account = this.account(publicKey);
    const previous = this.locks.get(publicKey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.topupNow(publicKey, account, clientHash));
    this.locks.set(publicKey, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(publicKey) === run) this.locks.delete(publicKey);
    }
  }

  private async topupNow(publicKey: string, account: string, clientHash: string) {
    const topups = this.store.robHireTopup;
    let row = await topups.findUnique({ where: { publicKey } });
    if (row?.state === "done") return this.view(row);
    if (!row) {
      // A few per connection a day, not one for life: a reload can lose a throwaway key, and judges may share an office's address.
      const since = new Date(this.now() - 86_400_000);
      if ((await topups.count({ where: { clientHash, createdAt: { gte: since } } })) >= this.settings.ROB_HIRE_TOPUPS_PER_CLIENT) {
        throw new RobError(409, "already_topped_up", "this connection already had its test USDC today: come back tomorrow");
      }
      const day = new Date(this.now());
      day.setUTCHours(0, 0, 0, 0);
      if ((await topups.count({ where: { createdAt: { gte: day } } })) >= this.settings.ROB_HIRE_DAILY_TOPUPS) {
        throw new RobError(503, "topups_exhausted", "today's top-ups are used up: try again tomorrow");
      }
      try {
        row = await topups.create({ data: { publicKey, account, clientHash } });
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
        // Raced: this key got there first; resume it.
        row = await topups.findUnique({ where: { publicKey } });
        if (!row) throw error;
      }
    }
    const steps: TopupSteps = { createTx: row.createTx, registerTx: row.registerTx, mintTx: row.mintTx };
    const { token } = this.desk.config;
    const record = async (data: Partial<TopupSteps> & { state?: string }) => {
      Object.assign(steps, data);
      row = await topups.update({ where: { publicKey }, data });
    };

    // 1. The implicit account: a transfer to a 64-hex id creates it, with the key as its full-access key.
    if (!(await this.accountExists(account))) {
      await record({ createTx: this.landed("create the account", await this.desk.send(account, [{ type: "Transfer", depositYocto: this.settings.ROB_HIRE_ACCOUNT_YOCTO }])) });
    }
    // 2. Registered on the token, so it can hold it (Ruggy pays the storage deposit).
    if ((await this.desk.rpc.view<unknown>(token, "storage_balance_of", { account_id: account })) === null) {
      const bounds = await this.desk.rpc.view<{ min?: string } | null>(token, "storage_balance_bounds", {}).catch(() => null);
      const deposit = bounds?.min && /^\d+$/.test(bounds.min) ? bounds.min : DEFAULT_STORAGE_YOCTO;
      await record({
        registerTx: this.landed("register on the token", await this.desk.send(token, [
          { type: "FunctionCall", methodName: "storage_deposit", args: { account_id: account, registration_only: true }, gasTgas: 10, depositYocto: deposit },
        ])),
      });
    }
    // 3. The price, minted once (the test token's mint is open).
    if (!steps.mintTx && (await this.balance(account)) < HIRE_PRICE_ATOMIC) {
      await record({
        mintTx: this.landed("mint the test token", await this.desk.send(token, [
          { type: "FunctionCall", methodName: "mint", args: { account_id: account, amount: HIRE_PRICE_ATOMIC.toString() }, gasTgas: 10 },
        ])),
      });
    }
    await record({ state: "done" });
    return this.view(row!);
  }

  private landed(step: string, outcome: Outcome): string {
    if (outcome.kind === "succeeded") return outcome.tx;
    throw new RobError(503, "topup_failed", `could not ${step}: ${outcome.error}; try again`);
  }

  private async accountExists(account: string): Promise<boolean> {
    try {
      await this.desk.rpc.call("query", { request_type: "view_account", finality: "optimistic", account_id: account });
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  private view(row: TopupRow) {
    const txs = { create: row.createTx, register: row.registerTx, mint: row.mintTx };
    return {
      publicKey: row.publicKey,
      account: row.account,
      amount: HIRE_PRICE_ATOMIC.toString(),
      token: this.desk.config.token,
      state: row.state,
      txs,
      nearblocks: Object.fromEntries(Object.entries(txs).map(([step, tx]) => [step, tx ? `${NEARBLOCKS}${tx}` : null])),
    };
  }
}

type Request = (path: string, init: RequestInit) => Promise<Response>;
type Assigned = { id: string; state: "submitted" | "working"; input: string };

/**
 * Ruggy's worker, inside the API: the market's own worker endpoints, reached in-process with the
 * listing's delivery token. Same protocol as apps/market-worker: start, run tx-check, deliver
 * (the gateway then relays the cheque) or fail (the cheque is never relayed, nothing is paid).
 */
export class HireDelivery {
  private running = false;
  private readonly attempts = new Map<string, number>();

  constructor(private readonly request: Request, private readonly token: string, private readonly log: (message: string) => void = (message) => console.warn(message)) {}

  private call(method: "GET" | "POST", path: string, body?: unknown) {
    return this.request(path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** One pass over the assigned tasks. */
  async once(): Promise<{ delivered: number; failed: number }> {
    if (this.running) return { delivered: 0, failed: 0 };
    this.running = true;
    let delivered = 0;
    let failed = 0;
    try {
      const listed = await this.call("GET", "/v1/market/tasks/assigned");
      if (!listed.ok) throw new Error(`assigned: HTTP ${listed.status}`);
      const { tasks } = (await listed.json()) as { tasks: Assigned[] };
      for (const task of tasks) {
        if (task.state === "submitted") {
          const started = await this.call("POST", `/v1/market/tasks/${task.id}/start`, {});
          if (!started.ok) continue; // taken, expired: the next pass sees the truth
        }
        let result: { markdown: string; json: unknown };
        try {
          result = txCheckJob(task.input);
        } catch (error) {
          // Bad input: the task fails and the cheque is never relayed.
          await this.call("POST", `/v1/market/tasks/${task.id}/fail`, { reason: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
          failed += 1;
          continue;
        }
        const sent = await this.call("POST", `/v1/market/tasks/${task.id}/deliver`, result);
        if (sent.ok) {
          delivered += 1;
          this.attempts.delete(task.id);
          continue;
        }
        // Refused (too large, expired...) or failing again and again: fail it rather than loop.
        const tries = (this.attempts.get(task.id) ?? 0) + 1;
        this.attempts.set(task.id, tries);
        if (sent.status < 500 || tries >= 3) {
          await this.call("POST", `/v1/market/tasks/${task.id}/fail`, { reason: `delivery refused: HTTP ${sent.status}` });
          this.attempts.delete(task.id);
          failed += 1;
        }
      }
    } finally {
      this.running = false;
    }
    return { delivered, failed };
  }

  start(intervalMs: number) {
    let quiet = false;
    const timer = setInterval(() => {
      this.once().then(() => { quiet = false; }, (error: unknown) => {
        // Say it once, not every pass (for example the market is not enabled on this API).
        if (!quiet) this.log(`rob hire delivery: ${error instanceof Error ? error.message : String(error)}`);
        quiet = true;
      });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}

const keySchema = z.object({ publicKey: z.string().min(1).max(100) }).strict();

export type HireOptions = {
  settings?: RobHireSettings;
  store?: HireStore;
  topupLimiter?: RateLimiter;
  /** Off in tests. */
  deliver?: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerHireRoutes(app: Hono<any>, context: RobExtrasContext, options: HireOptions = {}) {
  const settings = options.settings ?? robHireSettings();
  const hire = new RobHire(context.rob.asRuggy(), options.store ?? prisma, settings);
  const topupLimiter = options.topupLimiter ?? new MemoryRateLimiter(5, 3_600_000);
  const ipOf = (request: Parameters<typeof clientIp>[0]) => clientIp(request, context.trustProxy);
  const publicKeyOf = async (request: { req: { json(): Promise<unknown> } }) => {
    const parsed = keySchema.safeParse(await request.req.json().catch(() => null));
    if (!parsed.success) throw new RobError(400, "invalid_request", "publicKey is required");
    return parsed.data.publicKey;
  };

  app.post("/v1/rob/hire/terms", async (request) => {
    if (!context.limiters.read.allow(`rob:hire-terms:${ipOf(request)}`)) return request.json({ error: "rate_limited", message: "slow down: try again in a minute" }, 429);
    return request.json(await hire.terms(await publicKeyOf(request)));
  });
  app.post("/v1/rob/hire/topup", async (request) => {
    if (!topupLimiter.allow(`rob:hire-topup:${ipOf(request)}`)) return request.json({ error: "rate_limited", message: "slow down: try again later" }, 429);
    const publicKey = await publicKeyOf(request);
    return request.json(await hire.topup(publicKey, context.rob.clientHash(ipOf(request))));
  });

  if (settings.ROB_HIRE_DELIVERY_TOKEN && options.deliver !== false) {
    new HireDelivery((path, init) => Promise.resolve(app.request(path, init)), settings.ROB_HIRE_DELIVERY_TOKEN).start(settings.ROB_HIRE_POLL_MS);
  }
  return hire;
}
