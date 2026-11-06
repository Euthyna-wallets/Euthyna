import { createHash, randomUUID } from "node:crypto";

import { PrismaClient } from "@euthyna/db";

import { serializeNep413 } from "@near-wallet-selector/core";
import { KeyPair, transactions, utils } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RobConfig } from "./cards.js";
import { Hall, keyClaimMessage, prismaHall, summary, whoOf, type HallStore } from "./hall.js";
import type { NearRpc, Outcome } from "./near-tx.js";
import { amountOfArgs, RobService, type RobStore } from "./service.js";

const wallet = KeyPair.fromRandom("ed25519");
const throwaway = KeyPair.fromRandom("ed25519");
const THROWAWAY = throwaway.getPublicKey().toString();
const ACCOUNT = "thief.testnet";
const RECIPIENT = "ruggy.testnet";

type Play = { id: string; card: string; clientHash: string; publicKey: string | null; accountId: string | null; call: string | null; amount: string | null; verdict: string; gasBurnt: bigint | null };

function fakeStore(seed: Partial<Play>[] = []) {
  const keys = new Map<string, string>([[THROWAWAY, "player"], ["ed25519:shared", "shared"]]);
  const plays: Play[] = seed.map((play, index) => ({ id: `p${index}`, card: "pay-the-attacker", clientHash: "c1", publicKey: THROWAWAY, accountId: null, call: null, amount: null, verdict: "denied", gasBurnt: null, ...play }));
  const claims = new Map<string, { accountId: string; trophy: string; trophyTx: string | null; mintedAt: Date | null }>();
  const votes = new Set<string>();
  const kind = (publicKey: string | null) => (publicKey ? keys.get(publicKey) ?? null : null);
  const votesOf = (playId: string) => [...votes].filter((vote) => vote.startsWith(`${playId}|`)).length;
  const store: HallStore = {
    keyKind: async (publicKey) => kind(publicKey),
    claimedBy: async (publicKey) => plays.find((play) => play.publicKey === publicKey && play.accountId)?.accountId ?? null,
    linkPlays: async (publicKey, accountId) => plays.filter((play) => play.publicKey === publicKey && !play.accountId).map((play) => (play.accountId = accountId)).length,
    playsOf: async (accountId) => plays.filter((play) => play.accountId === accountId).length,
    claim: async (accountId) => claims.get(accountId) ?? null,
    startMint: async (accountId, staleBefore) => {
      const row = claims.get(accountId);
      if (row && !(row.trophy === "none" || (row.trophy === "minting" && row.mintedAt && row.mintedAt < staleBefore))) return false;
      claims.set(accountId, { accountId, trophy: "minting", trophyTx: null, mintedAt: new Date() });
      return true;
    },
    finishMint: async (accountId, result) => {
      claims.set(accountId, { accountId, trophy: result.minted ? "minted" : "none", trophyTx: result.minted ? result.tx : null, mintedAt: result.minted ? new Date() : null });
    },
    mintsSince: async () => [...claims.values()].filter((row) => row.trophy !== "none").length,
    creative: async () => {
      const top = plays.filter((play) => play.card === "forge").map((play) => ({ play, votes: votesOf(play.id) })).filter((item) => item.votes > 0).sort((a, b) => b.votes - a.votes)[0];
      return top ? { playId: top.play.id, call: top.play.call, accountId: top.play.accountId, publicKey: top.play.publicKey, kind: kind(top.play.publicKey), votes: top.votes } : null;
    },
    gas: async () => {
      const totals = new Map<string, { accountId: string | null; publicKey: string | null; gasBurnt: bigint }>();
      for (const play of plays.filter((item) => item.gasBurnt !== null && (item.accountId || kind(item.publicKey) === "player"))) {
        const who = play.accountId ?? play.publicKey!;
        const total = totals.get(who) ?? { accountId: play.accountId, publicKey: play.accountId ? null : play.publicKey, gasBurnt: 0n };
        total.gasBurnt += play.gasBurnt!;
        totals.set(who, total);
      }
      const top = [...totals.values()].sort((a, b) => (b.gasBurnt > a.gasBurnt ? 1 : -1))[0];
      return top ? { ...top, kind: top.accountId ? null : "player" } : null;
    },
    boldest: async () => {
      const top = plays.filter((play) => play.amount && play.verdict !== "paid").sort((a, b) => (BigInt(b.amount!) > BigInt(a.amount!) ? 1 : -1))[0];
      return top ? { accountId: top.accountId, publicKey: top.publicKey, kind: kind(top.publicKey), amount: top.amount!, card: top.card } : null;
    },
    recentForged: async (limit) => plays.filter((play) => play.card === "forge").slice(-limit).reverse().map((play) => ({ id: play.id, call: play.call, accountId: play.accountId, publicKey: play.publicKey, kind: kind(play.publicKey), votes: votesOf(play.id) })),
    play: async (id) => plays.find((play) => play.id === id) ?? null,
    vote: async (playId, voterHash) => {
      if (votes.has(`${playId}|${voterHash}`)) return false;
      votes.add(`${playId}|${voterHash}`);
      return true;
    },
    votesOf: async (playId) => votesOf(playId),
  };
  return { store, plays, claims };
}

function hallWith(options: { seed?: Partial<Play>[]; token?: string | null; mint?: () => Promise<Outcome>; balance?: string; walletKeyKind?: string } = {}) {
  const { store, plays, claims } = fakeStore(options.seed ?? [{}]);
  const mints: Array<Record<string, string>> = [];
  const rpc = {
    call: async (_method: string, params: { public_key: string }) => {
      if (params.public_key !== wallet.getPublicKey().toString()) throw new Error("UNKNOWN_ACCESS_KEY");
      return { permission: options.walletKeyKind ?? "FullAccess" };
    },
    view: async (_account: string, method: string) => {
      if (method === "ft_metadata") return { decimals: 6 };
      if (method === "storage_balance_bounds") return { min: "1250000000000000000000" };
      if (method === "ft_balance_of") return options.balance ?? "0";
      throw new Error(method);
    },
  } as unknown as Pick<NearRpc, "call" | "view">;
  const hall = new Hall({
    store,
    rpc,
    recipient: RECIPIENT,
    leashToken: options.token === undefined ? "leash.rob.testnet" : options.token,
    mint: async (input) => {
      mints.push(input);
      return options.mint ? options.mint() : { kind: "succeeded", tx: `MINT${mints.length}`, value: null };
    },
  });
  return { hall, plays, claims, mints };
}

/** What the browser does: the wallet signs NEP-413, the throwaway key signs the account. */
function signedClaim(hall: Hall, accountId = ACCOUNT, signer = wallet) {
  const challenge = hall.challenge(THROWAWAY);
  const payload = serializeNep413({ message: challenge.message, recipient: challenge.recipient, nonce: Buffer.from(challenge.nonce, "base64") });
  const signature = signer.sign(createHash("sha256").update(payload).digest()).signature;
  return {
    accountId,
    publicKey: signer.getPublicKey().toString(),
    signature: Buffer.from(signature).toString("base64"),
    throwawayKey: THROWAWAY,
    throwawaySignature: Buffer.from(throwaway.sign(new TextEncoder().encode(keyClaimMessage(accountId, challenge.nonce))).signature).toString("base64"),
    nonce: challenge.nonce,
  };
}

describe("claim", () => {
  it("links the key's plays to the wallet account and mints 1 LEASH, once", async () => {
    const { hall, plays, mints } = hallWith({ seed: [{}, { card: "forge" }] });
    const first = await hall.claim(signedClaim(hall));
    expect(first).toEqual({ accountId: ACCOUNT, plays: 2, trophy: { tx: "MINT1" } });
    expect(plays.every((play) => play.accountId === ACCOUNT)).toBe(true);
    expect(mints).toEqual([{ token: "leash.rob.testnet", accountId: ACCOUNT, amount: "1000000", storageDepositYocto: "1250000000000000000000" }]);
    // A second claim answers the same trophy and mints nothing.
    expect(await hall.claim(signedClaim(hall))).toEqual({ accountId: ACCOUNT, plays: 2, trophy: { tx: "MINT1" } });
    expect(mints).toHaveLength(1);
  });

  it("checks both signatures, the nonce and the wallet's full-access key", async () => {
    const { hall } = hallWith();
    const good = signedClaim(hall);
    await expect(hall.claim({ ...good, signature: Buffer.alloc(64).toString("base64") })).rejects.toMatchObject({ code: "invalid_signature" });
    // The nonce is single-use, even after a refusal.
    await expect(hall.claim(good)).rejects.toMatchObject({ code: "invalid_nonce" });
    // The throwaway key signed for another account.
    const other = signedClaim(hall);
    await expect(hall.claim({ ...other, throwawaySignature: signedClaim(hall, "someone.testnet").throwawaySignature })).rejects.toMatchObject({ code: "invalid_signature" });
    // A key that is not on the account.
    await expect(hall.claim(signedClaim(hall, ACCOUNT, KeyPair.fromRandom("ed25519")))).rejects.toMatchObject({ code: "not_full_access" });
    const limited = hallWith({ walletKeyKind: "FunctionCall" }).hall;
    await expect(limited.claim(signedClaim(limited))).rejects.toMatchObject({ code: "not_full_access" });
  });

  it("refuses a key claimed by another account", async () => {
    const { hall } = hallWith({ seed: [{ accountId: "first.testnet" }] });
    await expect(hall.claim(signedClaim(hall))).rejects.toMatchObject({ code: "key_claimed", status: 409 });
  });

  it("no trophy without a play, without a token, or when the mint fails (then it can be claimed again)", async () => {
    const empty = hallWith({ seed: [] });
    expect(await empty.hall.claim(signedClaim(empty.hall))).toMatchObject({ plays: 0, trophy: null });
    expect(empty.mints).toHaveLength(0);
    const noToken = hallWith({ token: null });
    expect(await noToken.hall.claim(signedClaim(noToken.hall))).toEqual({ accountId: ACCOUNT, plays: 1, trophy: null });
    let fail = true;
    const failing = hallWith({ mint: async () => (fail ? { kind: "failed", tx: "BAD", error: "Exceeded the prepaid gas" } : { kind: "succeeded", tx: "OK", value: null }) });
    expect(await failing.hall.claim(signedClaim(failing.hall))).toMatchObject({ trophy: null, trophyError: "the mint failed: Exceeded the prepaid gas" });
    fail = false;
    expect(await failing.hall.claim(signedClaim(failing.hall))).toMatchObject({ trophy: { tx: "OK" } });
  });

  it("an account that already holds the trophy on chain is not minted again", async () => {
    const { hall, mints } = hallWith({ balance: "1000000" });
    expect(await hall.claim(signedClaim(hall))).toMatchObject({ trophy: { tx: null } });
    expect(mints).toHaveLength(0);
  });
});

describe("Hall of thieves", () => {
  it("names the three winners and the recent forged calls, by account or short key", async () => {
    const { hall } = hallWith({
      seed: [
        { id: "a", card: "forge", call: "execute_near({\"amount\":\"5\"})", amount: "5", gasBurnt: 3n, clientHash: "x" },
        { id: "b", card: "overpriced-supplier", amount: "20000000", gasBurnt: 1n, accountId: "big.testnet" },
        { id: "c", card: "forge", call: "queue_rule_change({})", publicKey: "ed25519:shared", gasBurnt: 100n, amount: "99999999", verdict: "paid" },
      ],
    });
    await hall.vote("a", "voter1");
    const view = await hall.view();
    const short = `ed25519:${THROWAWAY.slice(8, 12)}…${THROWAWAY.slice(-3)}`;
    expect(view.creative).toEqual({ who: short, call: "execute_near({\"amount\":\"5\"})", votes: 1 });
    // The shared key's gas is nobody's; a paid call is not a refused cheque.
    expect(view.gas).toEqual({ who: short, gasBurnt: "3" });
    expect(view.boldest).toEqual({ who: "big.testnet", amount: "20000000", card: "overpriced-supplier" });
    expect(view.recent.map((play) => [play.id, play.who, play.votes])).toEqual([["c", "a shared key", 0], ["a", short, 1]]);
  });

  it("says nobody yet when nothing was played", async () => {
    const { hall } = hallWith({ seed: [] });
    expect(await hall.view()).toEqual({ creative: null, gas: null, boldest: null, recent: [] });
  });

  it("votes: forged calls only, once per voter, not your own", async () => {
    const { hall } = hallWith({ seed: [{ id: "f", card: "forge", clientHash: "me" }, { id: "k", card: "split-into-100" }] });
    expect(await hall.vote("f", "you")).toEqual({ playId: "f", votes: 1 });
    await expect(hall.vote("f", "you")).rejects.toMatchObject({ code: "already_voted" });
    await expect(hall.vote("f", "me")).rejects.toMatchObject({ code: "own_play" });
    await expect(hall.vote("k", "you")).rejects.toMatchObject({ code: "not_forged" });
    await expect(hall.vote("nope", "you")).rejects.toMatchObject({ code: "unknown_play" });
  });

  it("caches the view 30 seconds, and a vote refreshes it", async () => {
    let now = 0;
    const { store } = fakeStore([{ id: "f", card: "forge" }]);
    let reads = 0;
    const counted: HallStore = { ...store, creative: async () => { reads += 1; return store.creative(); } };
    const hall = new Hall({ store: counted, rpc: {} as never, recipient: RECIPIENT, leashToken: null, mint: async () => ({ kind: "rejected", error: "x" }), now: () => now });
    await hall.view();
    now = 29_000;
    await hall.view();
    expect(reads).toBe(1);
    await hall.vote("f", "v");
    expect((await hall.view()).creative?.votes).toBe(1);
    expect(reads).toBe(2);
  });

  it("who and summary", () => {
    expect(whoOf({ accountId: "a.testnet", publicKey: "ed25519:x", kind: "player" })).toBe("a.testnet");
    expect(whoOf({ accountId: null, publicKey: null, kind: null })).toBe("a shared key");
    expect(summary("x".repeat(200))).toHaveLength(96);
    expect(summary(null)).toBe("(no call recorded)");
  });
});

describe("RobService hooks for the Hall", () => {
  const config: RobConfig = {
    ruggyAccountId: "ruggy.testnet", vaultAccountId: "rob.nomos.testnet", daoAccountId: "rob.sputnik.testnet", token: "usdc.testnet",
    suppliers: ["supplier-a.testnet", "supplier-b.testnet"], role: "payments", seedReference: "rob-seed-1",
  };
  const BLOCK = utils.serialize.base_encode(new Uint8Array(32).fill(7));

  function service() {
    const plays: Array<Record<string, unknown>> = [];
    const updates: Array<{ id: string; gasBurnt: bigint }> = [];
    const sent: transactions.SignedTransaction[] = [];
    const reads: Array<Record<string, unknown>> = [];
    const store = {
      robKey: { findUnique: async () => null, count: async () => 0, create: async () => undefined, findMany: async () => [], updateMany: async () => undefined },
      robPlay: {
        create: async ({ data }: { data: Record<string, unknown> }) => plays.push(data),
        count: async () => 0,
        groupBy: async () => [],
        update: async ({ where, data }: { where: { id: string }; data: { gasBurnt: bigint } }) => updates.push({ id: where.id, gasBurnt: data.gasBurnt }),
      },
    } as unknown as RobStore;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const rpc = {
      accessKey: async () => ({ nonce: 1, block_hash: BLOCK }),
      finalBlockHash: async () => BLOCK,
      view: async () => "20000000",
      send: async (signedBase64: string) => {
        const signed = transactions.SignedTransaction.decode(Buffer.from(signedBase64, "base64"));
        sent.push(signed);
        if (signed.transaction.actions[0]!.addKey) return { kind: "succeeded", tx: "KEY", value: null };
        return { kind: "failed", tx: "TXF", error: "ERR_PERMISSION_DENIED:ERR_MAX_PER_TRANSFER" };
      },
      call: async (method: string, params: Record<string, unknown>) => {
        reads.push({ method, ...params });
        await gate;
        return { transaction_outcome: { outcome: { gas_burnt: 2_428_000_000_000 } }, receipts_outcome: [{ outcome: { gas_burnt: 3_000_000_000_000 } }, { outcome: { gas_burnt: "223182562500" } }] };
      },
    } as unknown as NearRpc;
    const rob = new RobService({ config, rpc, store, ruggySecretKey: KeyPair.fromRandom("ed25519").toString(), clientSalt: "s", sharedKeys: 1 });
    return { rob, plays, updates, sent, reads, release };
  }

  it("records the amount a card attempted and its call, and reads the gas after answering", async () => {
    const { rob, plays, updates, reads, release } = service();
    await rob.start();
    const result = await rob.play({ card: "overpriced-supplier", clientHash: "c" });
    // The answer came before the gas read finished.
    expect(result.tx).toBe("TXF");
    expect(updates).toHaveLength(0);
    expect(plays[0]).toMatchObject({ card: "overpriced-supplier", amount: "20000000", call: expect.stringContaining("20 USDC") });
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reads[0]).toMatchObject({ method: "tx", tx_hash: "TXF", sender_account_id: "ruggy.testnet" });
    expect(updates).toEqual([{ id: plays[0]!.id, gasBurnt: 5_651_182_562_500n }]);
  });

  it("a forged call keeps its amount and its call; a bribe has neither a transaction nor an amount", async () => {
    const { rob, plays, release } = service();
    release();
    await rob.start();
    await rob.forge({ method: "execute_near", args: { request: { amount: "000123" } }, clientHash: "c" });
    expect(plays[0]).toMatchObject({ card: "forge", amount: "123", call: 'execute_near({"request":{"amount":"000123"}})' });
    await rob.play({ card: "bribe-ruggy", clientHash: "c" });
    expect(plays[1]).toMatchObject({ amount: null, tx: null });
  });

  it("the trophy mint is one transaction on the token: storage_deposit then mint, from Ruggy's key", async () => {
    const { rob, sent, release } = service();
    release();
    sent.length = 0;
    await rob.mintTrophy({ token: "leash.rob.testnet", accountId: "thief.testnet", amount: "1000000", storageDepositYocto: "1250000000000000000000" });
    expect(sent).toHaveLength(1);
    const tx = sent[0]!.transaction;
    expect([tx.signerId, tx.receiverId]).toEqual(["ruggy.testnet", "leash.rob.testnet"]);
    expect(tx.actions.map((action: transactions.Action) => action.functionCall!.methodName)).toEqual(["storage_deposit", "mint"]);
    expect(BigInt(tx.actions[0]!.functionCall!.deposit.toString())).toBe(1_250_000_000_000_000_000_000n);
    await expect(rob.mintTrophy({ token: "usdc.testnet", accountId: "x.testnet", amount: "1", storageDepositYocto: "0" })).rejects.toMatchObject({ code: "not_configured" });
  });

  it("reads an amount only from digits", () => {
    expect(amountOfArgs({ request: { amount: "2000000" } })).toBe("2000000");
    expect(amountOfArgs({ request: { amount: 5 } })).toBe("5");
    expect(amountOfArgs({ request: { amount: "-1" } })).toBeNull();
    expect(amountOfArgs({ request: { amount: "1".repeat(79) } })).toBeNull();
    expect(amountOfArgs({ amount: "5" })).toBeNull();
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

/** The Prisma store and its SQL against PostgreSQL: DATABASE_URL=$TEST_DATABASE_URL prisma db push first. */
describe.skipIf(!databaseUrl)("prismaHall against PostgreSQL", () => {
  let prisma: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const player = `ed25519:player${run}`;
  const shared = `ed25519:shared${run}`;
  const account = `hall-${run}.testnet`;
  const ids: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await prisma.robKey.createMany({ data: [{ publicKey: player, kind: "player", clientHash: run }, { publicKey: shared, kind: "shared", clientHash: "server" }] });
  });

  afterAll(async () => {
    await prisma.robVote.deleteMany({ where: { playId: { in: ids } } });
    await prisma.robPlay.deleteMany({ where: { id: { in: ids } } });
    await prisma.robKey.deleteMany({ where: { publicKey: { in: [player, shared] } } });
    await prisma.robClaim.deleteMany({ where: { accountId: account } });
    await prisma.$disconnect();
  });

  it("links, ranks, votes and takes the mint once", async () => {
    const store = prismaHall(prisma);
    const play = async (data: { card: string; publicKey: string; amount?: string; gasBurnt?: bigint; verdict?: string }) => {
      const id = randomUUID();
      ids.push(id);
      await prisma.robPlay.create({ data: { id, refusedBy: "vault", clientHash: run, verdict: "denied", call: `${data.card}()`, ...data } });
      return id;
    };
    const forged = await play({ card: "forge", publicKey: player, amount: "1" + "0".repeat(70), gasBurnt: 10n ** 17n });
    await play({ card: "forge", publicKey: shared, amount: "9" + "0".repeat(71), verdict: "paid", gasBurnt: 10n ** 18n });
    await play({ card: "split-into-100", publicKey: player, gasBurnt: 10n ** 17n });

    expect(await store.keyKind(player)).toBe("player");
    expect(await store.gas()).toMatchObject({ accountId: null, publicKey: player, gasBurnt: 2n * 10n ** 17n });
    expect(await store.boldest()).toMatchObject({ publicKey: player, amount: "1" + "0".repeat(70), card: "forge", kind: "player" });

    expect(await store.vote(forged, "v1")).toBe(true);
    expect(await store.vote(forged, "v1")).toBe(false);
    expect(await store.votesOf(forged)).toBe(1);
    expect((await store.recentForged(6)).find((item) => item.id === forged)).toMatchObject({ votes: 1, kind: "player" });

    expect(await store.linkPlays(player, account)).toBe(2);
    expect(await store.claimedBy(player)).toBe(account);
    expect(await store.playsOf(account)).toBe(2);
    expect(await store.gas()).toMatchObject({ accountId: account, gasBurnt: 2n * 10n ** 17n });

    const takes = await Promise.all(Array.from({ length: 5 }, () => store.startMint(account, new Date(Date.now() - 120_000))));
    expect(takes.filter(Boolean)).toHaveLength(1);
    await store.finishMint(account, { minted: true, tx: "TX" });
    expect(await store.claim(account)).toMatchObject({ trophy: "minted", trophyTx: "TX" });
    expect(await store.startMint(account, new Date())).toBe(false);
  });
});
