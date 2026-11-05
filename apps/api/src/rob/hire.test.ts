import { Hono } from "hono";
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";

import { signCheque } from "@euthyna/sdk/cheque";

import { decodeCheque, parsePaymentHeader, verifyCheque, type ChequeChain, type PaymentRequirement } from "../market/cheque.js";
import { BUYER, buyerKey, cheque, requirement } from "../market/test-cheque.js";
import { HIRE_PRICE_ATOMIC, HireDelivery, registerHireRoutes, RobHire, type HireDesk, type HireStore } from "./hire.js";
import type { Outcome, RobAction } from "./near-tx.js";
import { RobError, RobService } from "./service.js";

const TOKEN = "test-ft.testnet";
const VAULT = "rob.nomos.testnet";
const settings = { ROB_HIRE_HANDLE: "ruggy-tx-check", ROB_HIRE_DAILY_TOPUPS: 5, ROB_HIRE_TOPUPS_PER_CLIENT: 2, ROB_HIRE_ACCOUNT_YOCTO: "1", ROB_HIRE_POLL_MS: 2_000, ROB_HIRE_DELIVERY_TOKEN: undefined };
const sign = (pair: KeyPair) => (hash: Uint8Array) => pair.sign(hash).signature;

describe("the cheque the browser builds (@euthyna/sdk/cheque)", () => {
  it("is byte for byte the cheque near-api-js builds, for the same key, nonce and height", async () => {
    // test-cheque.ts: nonce 101, maxBlockHeight 20 000, 30 Tgas, 1 yocto, {"receiver_id":VAULT,"amount":"2000000"} on USDC.
    const ours = await signCheque({
      requirement, senderId: BUYER, publicKey: buyerKey.getPublicKey().toString(), accessKeyNonce: 100n,
      blockHeight: 20_000n - 2n * BigInt(requirement.maxTimeoutSeconds) - 120n, sign: sign(buyerKey),
    });
    expect(ours.nonce).toBe(101n);
    expect(ours.maxBlockHeight).toBe(20_000n);
    expect(ours.signedDelegateAction).toBe(await cheque());
    expect(parsePaymentHeader(ours.header)).toEqual({ x402Version: 2, accepted: requirement, payload: { signedDelegateAction: ours.signedDelegateAction } });
  });

  it("passes every check of cheque.ts when the throwaway key pays from its implicit account", async () => {
    const pair = KeyPair.fromRandom("ed25519");
    const publicKey = pair.getPublicKey().toString();
    const account = RobService.attackerOf(publicKey);
    const robRequirement: PaymentRequirement = { scheme: "exact", network: "near:testnet", asset: TOKEN, amount: HIRE_PRICE_ATOMIC.toString(), payTo: VAULT, maxTimeoutSeconds: 720 };
    const chain: ChequeChain = {
      accessKey: async (accountId, key) => (accountId === account && key === publicKey ? { nonce: 1_234_000_000n, permission: "FullAccess" } : null),
      blockHeight: async () => 9_000n,
      ftBalance: async () => HIRE_PRICE_ATOMIC,
    };
    const signed = await signCheque({ requirement: robRequirement, senderId: account, publicKey, accessKeyNonce: "1234000000", blockHeight: "9000", sign: sign(pair) });
    const verified = await verifyCheque(parsePaymentHeader(signed.header), robRequirement, chain, async () => false);
    expect(verified).toMatchObject({ senderId: account, receiverId: TOKEN, methodName: "ft_transfer", deposit: 1n, nonce: 1_234_000_001n, signatureValid: true });
    expect(verified.argsText).toBe(`{"receiver_id":"${VAULT}","amount":"1000000"}`);
    // A cheque for another payee, or signed by another key, is refused.
    const forged = await signCheque({ requirement: { ...robRequirement, payTo: "attacker.testnet" }, senderId: account, publicKey, accessKeyNonce: 1, blockHeight: 9_000, sign: sign(pair) });
    await expect(verifyCheque(parsePaymentHeader(forged.header), robRequirement, chain, async () => false)).rejects.toMatchObject({ code: "requirement_mismatch" });
    const stolen = await signCheque({ requirement: robRequirement, senderId: account, publicKey, accessKeyNonce: 1234000000, blockHeight: 9_000, sign: sign(KeyPair.fromRandom("ed25519")) });
    expect(decodeCheque(parsePaymentHeader(stolen.header).payload.signedDelegateAction).signatureValid).toBe(false);
  });

  it("refuses an untrusted 402 before signing", async () => {
    const base = { senderId: BUYER, publicKey: buyerKey.getPublicKey().toString(), accessKeyNonce: 1, blockHeight: 1, sign: sign(buyerKey) };
    await expect(signCheque({ ...base, requirement: { ...requirement, amount: "0" } })).rejects.toThrow(/amount/);
    await expect(signCheque({ ...base, requirement: { ...requirement, amount: "1.5" } })).rejects.toThrow(/amount/);
    await expect(signCheque({ ...base, requirement: { ...requirement, maxTimeoutSeconds: 10 ** 9 } })).rejects.toThrow(/maxTimeoutSeconds/);
    await expect(signCheque({ ...base, requirement: { ...requirement, scheme: "upto" } })).rejects.toThrow(/scheme/);
  });
});

type Row = Awaited<ReturnType<HireStore["robHireTopup"]["create"]>>;

function fakes(o: { accountExists?: boolean; registered?: boolean; balance?: bigint; failOn?: string } = {}) {
  const rows = new Map<string, Row>();
  const sent: Array<{ receiverId: string; actions: RobAction[] }> = [];
  // Per account; the options set every account's starting state.
  const created = new Set<string>();
  const registered = new Set<string>();
  const minted = new Map<string, bigint>();
  const chain = {
    failOn: o.failOn,
    accountExists: (account: string) => (o.accountExists ?? false) || created.has(account),
    registered: (account: string) => (o.registered ?? false) || registered.has(account),
    balance: (account: string) => (o.balance ?? 0n) + (minted.get(account) ?? 0n),
    create: (account: string) => created.add(account),
  };
  let tx = 0;
  const store: HireStore = {
    robHireTopup: {
      findUnique: async ({ where }) => rows.get(where.publicKey) ?? null,
      count: async ({ where }) => [...rows.values()].filter((row) => row.createdAt >= where.createdAt.gte && (!where.clientHash || row.clientHash === where.clientHash)).length,
      create: async ({ data }) => {
        if (rows.has(data.publicKey)) throw Object.assign(new Error("unique"), { code: "P2002" });
        const row: Row = { ...data, state: "pending", createTx: null, registerTx: null, mintTx: null, createdAt: new Date() };
        rows.set(data.publicKey, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = { ...rows.get(where.publicKey)!, ...data } as Row;
        rows.set(where.publicKey, row);
        return row;
      },
    },
  };
  const desk: HireDesk = {
    config: { ruggyAccountId: "ruggy.testnet", vaultAccountId: VAULT, token: TOKEN },
    rpc: {
      call: async <T>(method: string, params: unknown): Promise<T> => {
        const request = params as { request_type?: string; account_id?: string };
        if (method === "block") return { header: { height: 5_000 } } as T;
        if (request.request_type === "view_account") {
          if (!chain.accountExists(request.account_id!)) throw new Error('{"name":"HANDLER_ERROR","cause":{"name":"UNKNOWN_ACCOUNT"}}');
          return {} as T;
        }
        if (request.request_type === "view_access_key") {
          if (!chain.accountExists(request.account_id!)) throw new Error("UNKNOWN_ACCESS_KEY");
          return { nonce: 4_242_000_000 } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
      view: async <T>(_token: string, method: string, args?: Record<string, unknown>): Promise<T> => {
        const account = String(args?.account_id ?? "");
        if (method === "storage_balance_of") return (chain.registered(account) ? { total: "1250000000000000000000", available: "0" } : null) as T;
        if (method === "storage_balance_bounds") return { min: "1250000000000000000000", max: "1250000000000000000000" } as T;
        if (method === "ft_balance_of") return chain.balance(account).toString() as T;
        throw new Error(`unexpected view ${method}`);
      },
    },
    send: async (receiverId, actions): Promise<Outcome> => {
      sent.push({ receiverId, actions });
      const action = actions[0]!;
      const step = action.type === "Transfer" ? "create" : action.type === "FunctionCall" ? action.methodName : action.type;
      if (chain.failOn === step) return { kind: "failed", tx: `TX${tx++}`, error: "Exceeded the prepaid gas" };
      const target = action.type === "FunctionCall" ? String(action.args.account_id) : receiverId;
      if (step === "create") created.add(target);
      if (step === "storage_deposit") registered.add(target);
      if (step === "mint") minted.set(target, (minted.get(target) ?? 0n) + HIRE_PRICE_ATOMIC);
      return { kind: "succeeded", tx: `TX${tx++}`, value: null };
    },
  };
  return { rows, sent, chain, store, desk, hire: new RobHire(desk, store, settings) };
}
const key = () => KeyPair.fromRandom("ed25519").getPublicKey().toString();
const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: RobError) => error.code);

describe("top-up", () => {
  it("creates the implicit account with 1 yocto, registers it on the token and mints the price, from Ruggy's key", async () => {
    const { hire, sent, rows } = fakes();
    const publicKey = key();
    const account = RobService.attackerOf(publicKey);
    const result = await hire.topup(publicKey, "client-a");
    expect(sent.map((call) => call.receiverId)).toEqual([account, TOKEN, TOKEN]);
    expect(sent[0]!.actions).toEqual([{ type: "Transfer", depositYocto: "1" }]);
    expect(sent[1]!.actions).toEqual([{ type: "FunctionCall", methodName: "storage_deposit", args: { account_id: account, registration_only: true }, gasTgas: 10, depositYocto: "1250000000000000000000" }]);
    expect(sent[2]!.actions).toEqual([{ type: "FunctionCall", methodName: "mint", args: { account_id: account, amount: "1000000" }, gasTgas: 10 }]);
    expect(result).toMatchObject({ account, amount: "1000000", state: "done", txs: { create: "TX0", register: "TX1", mint: "TX2" } });
    expect(result.nearblocks.mint).toBe("https://testnet.nearblocks.io/txns/TX2");
    expect(rows.get(publicKey)?.state).toBe("done");
  });

  it("is idempotent for a key: the second call sends nothing and returns the same transactions", async () => {
    const { hire, sent } = fakes();
    const publicKey = key();
    const [first, second] = await Promise.all([hire.topup(publicKey, "client-a"), hire.topup(publicKey, "client-a")]);
    expect(second).toEqual(first);
    expect(await hire.topup(publicKey, "client-b")).toEqual(first);
    expect(sent).toHaveLength(3);
  });

  it("gives a few top-ups per client (a lost key gets a new one) and stops at the daily cap", async () => {
    const { hire, sent } = fakes();
    await hire.topup(key(), "client-a");
    await hire.topup(key(), "client-a");
    await expect(code(hire.topup(key(), "client-a"))).resolves.toBe("already_topped_up");
    await hire.topup(key(), "client-b");
    await hire.topup(key(), "client-c");
    await hire.topup(key(), "client-d");
    await expect(code(hire.topup(key(), "client-e"))).resolves.toBe("topups_exhausted");
    expect(sent).toHaveLength(15);
  });

  it("skips what is already there and resumes after a failed step without minting twice", async () => {
    const existing = fakes({ accountExists: true, registered: true });
    await existing.hire.topup(key(), "client-a");
    expect(existing.sent.map((call) => (call.actions[0] as { methodName?: string }).methodName)).toEqual(["mint"]);

    const flaky = fakes({ failOn: "storage_deposit" });
    const publicKey = key();
    await expect(code(flaky.hire.topup(publicKey, "client-a"))).resolves.toBe("topup_failed");
    expect(flaky.rows.get(publicKey)).toMatchObject({ state: "pending", createTx: "TX0", registerTx: null });
    flaky.chain.failOn = undefined;
    const result = await flaky.hire.topup(publicKey, "client-a");
    expect(result.txs).toEqual({ create: "TX0", register: "TX2", mint: "TX3" });
    // Topped up by a crash between mint and record: the balance says so, no second mint.
    const crashed = fakes({ accountExists: true, registered: true, balance: HIRE_PRICE_ATOMIC });
    await crashed.hire.topup(key(), "client-a");
    expect(crashed.sent).toHaveLength(0);
  });

  it("refuses what is not an ed25519 key", async () => {
    const { hire } = fakes();
    await expect(code(hire.topup("secp256k1:abc", "client-a"))).resolves.toBe("invalid_key");
  });
});

describe("terms", () => {
  it("gives the nonce and a final height once the account exists, null before", async () => {
    const { hire, chain } = fakes();
    const publicKey = key();
    expect(await hire.terms(publicKey)).toMatchObject({ handle: "ruggy-tx-check", a2a: "/a2a/ruggy-tx-check/v1", nonce: null, blockHeight: "5000", toppedUp: false, vault: VAULT, price: "1000000" });
    chain.create(RobService.attackerOf(publicKey));
    expect(await hire.terms(publicKey)).toMatchObject({ nonce: "4242000000", account: RobService.attackerOf(publicKey) });
  });
});

describe("in-process delivery", () => {
  const TOKEN_MDT = `mdt_${"a".repeat(43)}`;
  const input = JSON.stringify({ chainId: 84532, to: "0x1111111111111111111111111111111111111111", data: "0x095ea7b30000000000000000000000002222222222222222222222222222222222222222ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", value: "0" });
  function market(tasks: Array<{ id: string; state: "submitted" | "working"; input: string }>, deliverStatus = 200) {
    const calls: Array<{ method: string; path: string; body: unknown; auth: string | null }> = [];
    const request = async (path: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      calls.push({ method: init.method ?? "GET", path, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get("authorization") });
      if (path === "/v1/market/tasks/assigned") return Response.json({ listing: "ruggy-tx-check", tasks });
      if (path.endsWith("/deliver")) return Response.json({ state: "completed" }, { status: deliverStatus });
      return Response.json({ state: "working" });
    };
    return { calls, delivery: new HireDelivery(request, TOKEN_MDT, () => undefined) };
  }

  it("starts, runs the worker's tx-check and delivers, with the listing's token", async () => {
    const { calls, delivery } = market([{ id: "t1", state: "submitted", input }]);
    expect(await delivery.once()).toEqual({ delivered: 1, failed: 0 });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /v1/market/tasks/assigned", "POST /v1/market/tasks/t1/start", "POST /v1/market/tasks/t1/deliver"]);
    expect(calls.every((call) => call.auth === `Bearer ${TOKEN_MDT}`)).toBe(true);
    const body = calls[2]!.body as { markdown: string; json: { functionName: string } };
    expect(body.markdown).toMatch(/\*\*high\*\* · Unlimited approval/);
    expect(body.json.functionName).toBe("approve");
  });

  it("fails a task whose input is not a transaction (the cheque is then never relayed)", async () => {
    const { calls, delivery } = market([{ id: "t2", state: "working", input: "check this please" }]);
    expect(await delivery.once()).toEqual({ delivered: 0, failed: 1 });
    expect(calls[1]).toMatchObject({ path: "/v1/market/tasks/t2/fail", body: { reason: expect.stringMatching(/to must be an address/) } });
  });

  it("fails a delivery the gateway refuses, and retries a server error at most three times", async () => {
    const refused = market([{ id: "t3", state: "working", input }], 413);
    expect(await refused.delivery.once()).toEqual({ delivered: 0, failed: 1 });
    const flaky = market([{ id: "t4", state: "working", input }], 500);
    expect(await flaky.delivery.once()).toEqual({ delivered: 0, failed: 0 });
    await flaky.delivery.once();
    expect(await flaky.delivery.once()).toEqual({ delivered: 0, failed: 1 });
  });
});

describe("routes", () => {
  it("POST /v1/rob/hire/topup and /terms answer for the caller's address", async () => {
    const { desk, store, sent } = fakes();
    const app = new Hono();
    app.onError((error, context) => (error instanceof RobError ? context.json({ error: error.code, message: error.message }, error.status) : context.json({ error: "internal" }, 500)));
    const rob = { asRuggy: () => desk, clientHash: (address: string) => `hash:${address}` } as unknown as RobService;
    const allow = { allow: () => true };
    registerHireRoutes(app, { rob, limiters: { session: allow, play: allow, read: allow }, trustProxy: false }, { settings, store, deliver: false });
    const publicKey = key();
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const topup = await post("/v1/rob/hire/topup", { publicKey });
    expect(topup.status).toBe(200);
    expect(await topup.json()).toMatchObject({ state: "done", account: RobService.attackerOf(publicKey) });
    expect(sent).toHaveLength(3);
    expect((await post("/v1/rob/hire/topup", { publicKey: key() })).status).toBe(200);
    expect((await post("/v1/rob/hire/topup", { publicKey: key() })).status).toBe(409);
    expect((await post("/v1/rob/hire/topup", { nope: 1 })).status).toBe(400);
    const terms = await post("/v1/rob/hire/terms", { publicKey });
    expect(await terms.json()).toMatchObject({ toppedUp: true, nonce: "4242000000" });
  });
});
