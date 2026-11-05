/**
 * Rob the Agent: the wallet claim, the Hall of thieves and the $LEASH testnet trophy.
 *
 * Claim: the player's wallet signs a NEP-413 message naming the throwaway key (and a nonce from here); the
 * throwaway key signs a message naming the wallet account. Both checked, the key's plays are linked to the
 * account and, when ROB_LEASH_TOKEN is set and the account has a play, Ruggy's full-access key mints it
 * 1 LEASH once (storage_deposit then mint, which only Ruggy may call; one transaction on the token).
 *
 * Hall: three tiles (most voted forged call, most gas burnt, largest amount refused) and the recent forged
 * calls with their votes. Read from the recorded plays, cached 30 s.
 */
import { randomBytes } from "node:crypto";

import { verifySignature } from "@near-wallet-selector/core";
import type { PrismaClient } from "@mandateos/db";
import type { Context, Hono } from "hono";
import { utils } from "near-api-js";
import { z } from "zod";

import { clientIp } from "../market/routes.js";
import { NEAR_ACCOUNT_ID } from "../near-auth.js";
import type { RobExtrasContext } from "./extras.js";
import type { NearRpc, Outcome } from "./near-tx.js";
import { RobError } from "./service.js";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type Author = { accountId: string | null; publicKey: string | null; kind: string | null };
type ClaimRow = { accountId: string; trophy: string; trophyTx: string | null; mintedAt: Date | null };

/** What the Hall and the claim read and write (prismaHall adapts the Prisma client; tests use a fake). */
export interface HallStore {
  keyKind(publicKey: string): Promise<string | null>;
  /** An account another claim already linked this key's plays to. */
  claimedBy(publicKey: string): Promise<string | null>;
  linkPlays(publicKey: string, accountId: string): Promise<number>;
  playsOf(accountId: string): Promise<number>;
  claim(accountId: string): Promise<ClaimRow | null>;
  /** Take the right to mint for this account: true for exactly one caller until finishMint. */
  startMint(accountId: string, staleBefore: Date): Promise<boolean>;
  finishMint(accountId: string, result: { minted: true; tx: string | null } | { minted: false }): Promise<void>;
  mintsSince(since: Date): Promise<number>;
  creative(): Promise<(Author & { playId: string; call: string | null; votes: number }) | null>;
  gas(): Promise<(Author & { gasBurnt: bigint }) | null>;
  boldest(): Promise<(Author & { amount: string; card: string }) | null>;
  recentForged(limit: number): Promise<Array<Author & { id: string; call: string | null; votes: number }>>;
  play(id: string): Promise<{ card: string; clientHash: string } | null>;
  /** False when this voter already voted for this play. */
  vote(playId: string, voterHash: string): Promise<boolean>;
  votesOf(playId: string): Promise<number>;
}

/** The Hall's store on the Prisma client (the same one RobService writes with). */
export function prismaHall(db: PrismaClient): HallStore {
  const kinds = async (publicKeys: Array<string | null>) => {
    const keys = [...new Set(publicKeys.filter((key): key is string => Boolean(key)))];
    const rows = keys.length ? await db.robKey.findMany({ where: { publicKey: { in: keys } }, select: { publicKey: true, kind: true } }) : [];
    return new Map(rows.map((row) => [row.publicKey, row.kind]));
  };
  const votes = async (playIds: string[]) => {
    const rows = playIds.length ? await db.robVote.groupBy({ by: ["playId"], where: { playId: { in: playIds } }, _count: { playId: true } }) : [];
    return new Map(rows.map((row) => [row.playId, row._count.playId]));
  };
  return {
    keyKind: async (publicKey) => (await db.robKey.findUnique({ where: { publicKey }, select: { kind: true } }))?.kind ?? null,
    claimedBy: async (publicKey) => (await db.robPlay.findFirst({ where: { publicKey, accountId: { not: null } }, select: { accountId: true } }))?.accountId ?? null,
    linkPlays: async (publicKey, accountId) => (await db.robPlay.updateMany({ where: { publicKey, accountId: null }, data: { accountId } })).count,
    playsOf: (accountId) => db.robPlay.count({ where: { accountId } }),
    claim: (accountId) => db.robClaim.findUnique({ where: { accountId }, select: { accountId: true, trophy: true, trophyTx: true, mintedAt: true } }),
    startMint: async (accountId, staleBefore) => {
      try {
        await db.robClaim.create({ data: { accountId, trophy: "minting", mintedAt: new Date() } });
        return true;
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
      }
      // An earlier claim found no play, or a mint failed or died half-way (checked on chain before minting again).
      const taken = await db.robClaim.updateMany({
        where: { accountId, OR: [{ trophy: "none" }, { trophy: "minting", mintedAt: { lt: staleBefore } }] },
        data: { trophy: "minting", mintedAt: new Date() },
      });
      return taken.count === 1;
    },
    finishMint: async (accountId, result) => {
      await db.robClaim.update({
        where: { accountId },
        data: result.minted ? { trophy: "minted", trophyTx: result.tx, mintedAt: new Date() } : { trophy: "none", mintedAt: null },
      });
    },
    mintsSince: (since) => db.robClaim.count({ where: { trophy: { in: ["minted", "minting"] }, mintedAt: { gt: since } } }),
    creative: async () => {
      const [top] = await db.robVote.groupBy({ by: ["playId"], _count: { playId: true }, orderBy: [{ _count: { playId: "desc" } }, { playId: "asc" }], take: 1 });
      if (!top) return null;
      const play = await db.robPlay.findUnique({ where: { id: top.playId }, select: { id: true, call: true, accountId: true, publicKey: true } });
      if (!play) return null;
      const kind = (await kinds([play.publicKey])).get(play.publicKey ?? "") ?? null;
      return { playId: play.id, call: play.call, accountId: play.accountId, publicKey: play.publicKey, kind, votes: top._count.playId };
    },
    gas: async () => {
      // Per player: the claimed account, or else the player's own throwaway key (shared keys are nobody's).
      const rows = await db.$queryRaw<Array<{ accountId: string | null; publicKey: string | null; gasBurnt: string }>>`
        SELECT p."accountId" AS "accountId",
               CASE WHEN p."accountId" IS NULL THEN p."publicKey" END AS "publicKey",
               SUM(p."gasBurnt")::text AS "gasBurnt"
        FROM rob_play p
        LEFT JOIN rob_key k ON k."publicKey" = p."publicKey"
        WHERE p."gasBurnt" IS NOT NULL AND (p."accountId" IS NOT NULL OR k.kind = 'player')
        GROUP BY 1, 2
        ORDER BY SUM(p."gasBurnt") DESC
        LIMIT 1`;
      const top = rows[0];
      return top ? { accountId: top.accountId, publicKey: top.publicKey, kind: top.accountId ? null : "player", gasBurnt: BigInt(top.gasBurnt) } : null;
    },
    boldest: async () => {
      const play = await db.robPlay.findFirst({
        where: { amount: { not: null }, verdict: { not: "paid" } },
        orderBy: [{ amount: "desc" }, { createdAt: "asc" }],
        select: { accountId: true, publicKey: true, amount: true, card: true },
      });
      if (!play?.amount) return null;
      const kind = (await kinds([play.publicKey])).get(play.publicKey ?? "") ?? null;
      return { accountId: play.accountId, publicKey: play.publicKey, kind, amount: play.amount.toFixed(0), card: play.card };
    },
    recentForged: async (limit) => {
      const plays = await db.robPlay.findMany({ where: { card: "forge" }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, call: true, accountId: true, publicKey: true } });
      const [keyKinds, counts] = await Promise.all([kinds(plays.map((play) => play.publicKey)), votes(plays.map((play) => play.id))]);
      return plays.map((play) => ({ ...play, kind: keyKinds.get(play.publicKey ?? "") ?? null, votes: counts.get(play.id) ?? 0 }));
    },
    play: (id) => db.robPlay.findUnique({ where: { id }, select: { card: true, clientHash: true } }),
    vote: async (playId, voterHash) => {
      try {
        await db.robVote.create({ data: { playId, voterHash } });
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") return false;
        throw error;
      }
    },
    votesOf: (playId) => db.robVote.count({ where: { playId } }),
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** What the wallet signs (NEP-413 `message`): it names the throwaway key. */
export function walletClaimMessage(throwawayKey: string, nonce: string): string {
  return ["Rob the Agent: claim my plays", `throwaway_key: ${throwawayKey}`, `nonce: ${nonce}`].join("\n");
}

/** What the throwaway key signs (ed25519 over these UTF-8 bytes): it names the wallet account. */
export function keyClaimMessage(accountId: string, nonce: string): string {
  return ["Rob the Agent: my plays belong to", `account_id: ${accountId}`, `nonce: ${nonce}`].join("\n");
}

const ED25519 = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type HallOptions = {
  store: HallStore;
  rpc: Pick<NearRpc, "call" | "view">;
  /** NEP-413 recipient the wallet signs for. */
  recipient: string;
  /** The $LEASH token (contracts/leash, Ruggy is its minter); null: no trophy. */
  leashToken: string | null;
  /** Ruggy's full-access key signs the mint (RobService.mintTrophy). */
  mint: (input: { token: string; accountId: string; amount: string; storageDepositYocto: string }) => Promise<Outcome>;
  /** Trophies a day, for everyone: each costs Ruggy a storage deposit (about 0.00125 NEAR) and 20 Tgas at most. */
  mintsPerDay?: number;
  cacheMs?: number;
  now?: () => number;
};

export type Who = string;
export type HallView = {
  creative: { who: Who; call: string; votes: number } | null;
  gas: { who: Who; gasBurnt: string } | null;
  boldest: { who: Who; amount: string; card: string } | null;
  recent: Array<{ id: string; call: string; votes: number; who: Who }>;
};

export type ClaimInput = {
  accountId: string;
  /** The wallet's public key and its NEP-413 signature (base64). */
  publicKey: string;
  signature: string;
  throwawayKey: string;
  /** The throwaway key's ed25519 signature over keyClaimMessage (base64). */
  throwawaySignature: string;
  nonce: string;
};

export type ClaimResult = { accountId: string; plays: number; trophy: { tx: string | null } | null; trophyError?: string };

export class Hall {
  private readonly nonces = new Map<string, { throwawayKey: string; expiresAt: number }>();
  private cache: { at: number; value: HallView } | null = null;
  private tokenInfo: { amount: string; storageDepositYocto: string } | null = null;
  private readonly now: () => number;

  constructor(private readonly options: HallOptions) {
    this.now = options.now ?? Date.now;
  }

  /** A single-use nonce for one claim, valid 5 minutes, and the two messages to sign. */
  challenge(throwawayKey: string) {
    if (!ED25519.test(throwawayKey)) throw new RobError(400, "invalid_key", "throwawayKey must be an ed25519 key, ed25519:<base58>");
    const now = this.now();
    for (const [nonce, entry] of this.nonces) if (entry.expiresAt < now) this.nonces.delete(nonce);
    if (this.nonces.size >= 5_000) throw new RobError(503, "busy", "too many claims at once: try again in a minute");
    const nonce = randomBytes(32).toString("base64");
    this.nonces.set(nonce, { throwawayKey, expiresAt: now + 5 * 60_000 });
    return { nonce, recipient: this.options.recipient, message: walletClaimMessage(throwawayKey, nonce), trophy: Boolean(this.options.leashToken) };
  }

  async claim(input: ClaimInput): Promise<ClaimResult> {
    const accountId = input.accountId.trim().toLowerCase();
    if (!NEAR_ACCOUNT_ID.test(accountId)) throw new RobError(400, "invalid_account", "accountId must be a NEAR account id");
    const entry = this.nonces.get(input.nonce);
    this.nonces.delete(input.nonce);
    if (!entry || entry.expiresAt < this.now() || entry.throwawayKey !== input.throwawayKey) {
      throw new RobError(403, "invalid_nonce", "this claim expired or was already used: start again");
    }
    // 1. The wallet: a NEP-413 signature (as the console's sign-in checks it), by a full-access key of the account.
    let walletSigned = false;
    try {
      walletSigned = verifySignature({
        publicKey: input.publicKey,
        signature: input.signature,
        message: walletClaimMessage(input.throwawayKey, input.nonce),
        nonce: Buffer.from(input.nonce, "base64"),
        recipient: this.options.recipient,
      });
    } catch {
      walletSigned = false;
    }
    if (!walletSigned) throw new RobError(403, "invalid_signature", "the wallet's signature does not match the claim");
    if (!await this.isFullAccessKey(accountId, input.publicKey)) throw new RobError(403, "not_full_access", `the signing key is not a full-access key of ${accountId}`);
    // 2. The throwaway key: it names the account.
    let keySigned = false;
    try {
      keySigned = utils.PublicKey.fromString(input.throwawayKey).verify(new TextEncoder().encode(keyClaimMessage(accountId, input.nonce)), Buffer.from(input.throwawaySignature, "base64"));
    } catch {
      keySigned = false;
    }
    if (!keySigned) throw new RobError(403, "invalid_signature", "the throwaway key's signature does not name this account");
    // 3. A key a player's browser put on Ruggy's account (not a shared one), not already claimed by someone else.
    if (await this.options.store.keyKind(input.throwawayKey) !== "player") throw new RobError(403, "unknown_key", "this key never played on Ruggy's account");
    const owner = await this.options.store.claimedBy(input.throwawayKey);
    if (owner && owner !== accountId) throw new RobError(409, "key_claimed", `these plays were already claimed by ${owner}`);
    const linked = await this.options.store.linkPlays(input.throwawayKey, accountId);
    if (linked) this.cache = null;
    const plays = await this.options.store.playsOf(accountId);
    return { accountId, plays, ...(await this.trophy(accountId, plays)) };
  }

  private async isFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
    try {
      const key = await this.options.rpc.call<{ permission?: unknown }>("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
      return key.permission === "FullAccess";
    } catch {
      return false;
    }
  }

  /** 1 LEASH, once per account, only after a recorded play. */
  private async trophy(accountId: string, plays: number): Promise<Pick<ClaimResult, "trophy" | "trophyError">> {
    const token = this.options.leashToken;
    if (!token) return { trophy: null };
    const existing = await this.options.store.claim(accountId);
    if (existing?.trophy === "minted") return { trophy: { tx: existing.trophyTx } };
    if (plays === 0) return { trophy: null, trophyError: "play a card first: the trophy goes to accounts with a recorded play" };
    if (existing?.trophy === "minting" && existing.mintedAt && existing.mintedAt.getTime() > this.now() - 2 * 60_000) {
      return { trophy: null, trophyError: "your trophy is being minted: claim again in a minute" };
    }
    if (await this.options.store.mintsSince(new Date(this.now() - 24 * 3_600_000)) >= (this.options.mintsPerDay ?? 500)) {
      return { trophy: null, trophyError: "today's trophies are all minted: claim again tomorrow" };
    }
    if (!await this.options.store.startMint(accountId, new Date(this.now() - 2 * 60_000))) {
      return { trophy: null, trophyError: "your trophy is being minted: claim again in a minute" };
    }
    try {
      const info = await this.leashInfo(token);
      // A mint that landed before a crash: the balance shows it, nothing is minted twice.
      const balance = BigInt(await this.options.rpc.view<string>(token, "ft_balance_of", { account_id: accountId }));
      if (balance >= BigInt(info.amount)) {
        await this.options.store.finishMint(accountId, { minted: true, tx: null });
        return { trophy: { tx: null } };
      }
      const outcome = await this.options.mint({ token, accountId, amount: info.amount, storageDepositYocto: info.storageDepositYocto });
      if (outcome.kind === "succeeded") {
        await this.options.store.finishMint(accountId, { minted: true, tx: outcome.tx });
        return { trophy: { tx: outcome.tx } };
      }
      await this.options.store.finishMint(accountId, { minted: false });
      return { trophy: null, trophyError: `the mint failed: ${outcome.error}` };
    } catch (error) {
      await this.options.store.finishMint(accountId, { minted: false }).catch(() => undefined);
      return { trophy: null, trophyError: `the mint failed: ${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}` };
    }
  }

  private async leashInfo(token: string) {
    if (!this.tokenInfo) {
      const [metadata, bounds] = await Promise.all([
        this.options.rpc.view<{ decimals: number }>(token, "ft_metadata"),
        this.options.rpc.view<{ min: string }>(token, "storage_balance_bounds"),
      ]);
      if (!Number.isInteger(metadata.decimals) || metadata.decimals < 0 || metadata.decimals > 32) throw new Error("unexpected token decimals");
      // Bounded: never more than 0.01 NEAR of storage per trophy.
      if (BigInt(bounds.min) > 10n ** 22n) throw new Error("the token asks too much storage deposit");
      this.tokenInfo = { amount: (10n ** BigInt(metadata.decimals)).toString(), storageDepositYocto: bounds.min };
    }
    return this.tokenInfo;
  }

  // -------------------------------------------------------------------------
  // Hall of thieves
  // -------------------------------------------------------------------------

  async view(): Promise<HallView> {
    if (this.cache && this.now() - this.cache.at < (this.options.cacheMs ?? 30_000)) return this.cache.value;
    const store = this.options.store;
    const [creative, gas, boldest, recent] = await Promise.all([store.creative(), store.gas(), store.boldest(), store.recentForged(6)]);
    const value: HallView = {
      creative: creative ? { who: whoOf(creative), call: summary(creative.call), votes: creative.votes } : null,
      gas: gas ? { who: whoOf(gas), gasBurnt: gas.gasBurnt.toString() } : null,
      boldest: boldest ? { who: whoOf(boldest), amount: boldest.amount, card: boldest.card } : null,
      recent: recent.map((play) => ({ id: play.id, call: summary(play.call), votes: play.votes, who: whoOf(play) })),
    };
    this.cache = { at: this.now(), value };
    return value;
  }

  async vote(playId: string, voterHash: string): Promise<{ playId: string; votes: number }> {
    const play = await this.options.store.play(playId);
    if (!play) throw new RobError(404, "unknown_play", "no such play");
    if (play.card !== "forge") throw new RobError(409, "not_forged", "only forged calls are voted on");
    if (play.clientHash === voterHash) throw new RobError(403, "own_play", "vote for someone else's call");
    if (!await this.options.store.vote(playId, voterHash)) throw new RobError(409, "already_voted", "one vote per call");
    this.cache = null;
    return { playId, votes: await this.options.store.votesOf(playId) };
  }
}

/** The claimed account, else the player's throwaway key, short. */
export function whoOf(author: Author): Who {
  if (author.accountId) return author.accountId;
  if (author.publicKey && author.kind === "player") {
    const body = author.publicKey.replace(/^ed25519:/, "");
    return `ed25519:${body.slice(0, 4)}…${body.slice(-3)}`;
  }
  return "a shared key";
}

/** A forged call in one short line: method(args…). */
export function summary(call: string | null): string {
  const text = (call ?? "").replace(/\s+/g, " ").trim();
  return text.length > 96 ? `${text.slice(0, 95)}…` : text || "(no call recorded)";
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const challengeSchema = z.object({ throwawayKey: z.string().min(1).max(100) }).strict();
const claimSchema = z.object({
  accountId: z.string().min(2).max(64),
  publicKey: z.string().min(1).max(100),
  signature: z.string().min(1).max(200),
  throwawayKey: z.string().min(1).max(100),
  throwawaySignature: z.string().min(1).max(200),
  nonce: z.string().min(1).max(100),
}).strict();
const voteSchema = z.object({ playId: z.string().uuid() }).strict();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerHallRoutes(app: Hono<any>, context: RobExtrasContext, hall?: Hall) {
  const { rob, limiters, trustProxy } = context;
  const leashToken = process.env.ROB_LEASH_TOKEN?.trim() || null;
  const instance = hall ?? new Hall({
    store: prismaHall(rob.store as unknown as PrismaClient),
    rpc: rob.rpc,
    recipient: rob.ruggyAccountId,
    leashToken,
    mint: (input) => rob.mintTrophy(input),
  });
  const ipOf = (c: Context) => clientIp(c, trustProxy);
  const limit = (limiter: RobExtrasContext["limiters"]["read"], name: string) => async (c: Context, next: () => Promise<void>) => {
    if (!limiter.allow(`rob:${name}:${ipOf(c)}`)) return c.json({ error: "rate_limited", message: "slow down: try again in a minute" }, 429);
    await next();
  };
  const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<T> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new RobError(400, "invalid_request", parsed.error.issues.map((issue) => issue.message).join("; "));
    return parsed.data;
  };

  app.get("/v1/rob/hall", limit(limiters.read, "read"), async (c) => {
    c.header("cache-control", "public, max-age=30");
    return c.json(await instance.view());
  });
  app.post("/v1/rob/hall/vote", limit(limiters.play, "play"), async (c) => {
    const { playId } = await body(c, voteSchema);
    return c.json(await instance.vote(playId, rob.clientHash(ipOf(c))));
  });
  app.post("/v1/rob/claim/challenge", limit(limiters.play, "play"), async (c) => {
    const { throwawayKey } = await body(c, challengeSchema);
    return c.json(instance.challenge(throwawayKey));
  });
  // A claim can mint: the same budget as new keys (5 an hour per address).
  app.post("/v1/rob/claim", limit(limiters.session, "claim"), async (c) => c.json(await instance.claim(await body(c, claimSchema))));
}
