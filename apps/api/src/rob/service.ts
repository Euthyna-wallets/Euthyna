/**
 * Rob the Agent: plays the cards on NEAR testnet and records what the chain answered.
 *
 * Keys on Ruggy's account:
 * - his full-access key, held here: adds and deletes the players' keys, signs
 *   "Crown Yourself" (a DAO call no function-call key can make) and mints test tokens;
 * - one function-call key per player, made in the browser, limited to the vault's
 *   execute_near and queue_rule_change, with a small gas allowance, deleted after 24 h;
 * - a few shared function-call keys, made at start, for plays without a key of their own
 *   (they also open Base operations, for Look Legit).
 *
 * The three owners' keys (a demo company) play Inside Job: two of them vote a bad rule,
 * the third, as the council, vetoes it. The same council bot vetoes Look Legit's payment
 * during its wait, and sweeps: any rule change or Ruggy operation left pending is vetoed.
 *
 * Nothing here decides a verdict: the vault, the DAO or NEAR refuses, and this
 * reports it. A payment the law allows (forged in expert mode) does go through,
 * to one of the two listed suppliers, which are accounts of ours.
 */
import { createHash, randomBytes } from "node:crypto";

import { KeyPair, transactions, utils } from "near-api-js";

import { proposalArgs } from "@mandateos/sdk/roles";
import { encodeFunctionData, erc20Abi, getAddress, hexToBytes, type Hex } from "viem";

import { CARDS, cardById, cardCall, EXECUTE_GAS_TGAS, LAWS, PLAYER_METHODS, SHARED_METHODS, type CardInfo, type Defender, type RobConfig } from "./cards.js";
import { buildTransaction, hashOfSigned, signWith, type NearRpc, type Outcome, type RobAction } from "./near-tx.js";

export class RobError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 429 | 503, readonly code: string, message: string) {
    super(message);
  }
}

export type Verdict = "denied" | "counter" | "vetoed" | "paid";
export type Step = { label: string; detail: string; tx: string | null };

export type PlayResult = {
  card: string;
  verdict: Verdict;
  refusedBy: Defender | null;
  /** Index of the law that answered (0 = law I), null when none applies. */
  line: number | null;
  error: string | null;
  tx: string | null;
  nearblocks: string | null;
  /** What was sent, in one line. */
  call: string;
  signedBy: string;
  counter?: { counter: number; expires_in: number; to: string };
  /** Look Legit and Inside Job: each transaction of the sequence. */
  steps?: Step[];
  ms: number;
};

type RobKeyRow = { publicKey: string; kind: string; clientHash: string; createdAt: Date; deletedAt: Date | null };
type RobPlayRow = { card: string; verdict: string; refusedBy: string; error: string | null; tx: string | null; publicKey: string | null; clientHash: string };

/** The two tables the game writes (a Prisma client fits). */
export interface RobStore {
  robKey: {
    findUnique(args: { where: { publicKey: string } }): Promise<RobKeyRow | null>;
    count(args: { where: { deletedAt: null; createdAt?: { gt: Date } } }): Promise<number>;
    create(args: { data: { publicKey: string; kind: string; clientHash: string } }): Promise<unknown>;
    findMany(args: { where: { deletedAt: null; createdAt: { lt: Date } }; take: number; orderBy: { createdAt: "asc" } }): Promise<RobKeyRow[]>;
    updateMany(args: { where: { publicKey: { in: string[] } }; data: { deletedAt: Date } }): Promise<unknown>;
  };
  robPlay: {
    create(args: { data: RobPlayRow }): Promise<unknown>;
    count(args?: { where?: { verdict?: string; card?: string; clientHash?: string; createdAt?: { gt: Date } } }): Promise<number>;
    groupBy(args: { by: ["clientHash"] }): Promise<unknown[]>;
  };
}

export type RobServiceOptions = {
  config: RobConfig;
  rpc: NearRpc;
  store: RobStore;
  /** Ruggy's full-access key (ed25519:…). */
  ruggySecretKey: string;
  /** Hashes client addresses; never stored in clear. */
  clientSalt: string;
  /** Players' keys alive at once. */
  maxActiveKeys?: number;
  keyLifetimeMs?: number;
  /** Gas a player's key may spend: a cap, the real cost of a refused play is far lower. */
  keyAllowanceYocto?: string;
  /**
   * Same for the shared keys. NEAR holds a call's whole prepaid gas, at a pessimistic price, against the
   * allowance until the call ends: Look Legit's two calls in a row need more than a player's cap.
   */
  sharedKeyAllowanceYocto?: string;
  sharedKeys?: number;
  /** Keep the vault above this much test token (base units), minting more when it falls below. */
  vaultFloor?: bigint;
  /** The demo company's three owners: two vote in Inside Job, the third is the council bot. */
  owners?: Array<{ accountId: string; secretKey: string }> | undefined;
  /** Inside Job games a day, for everyone (each costs four transactions). */
  insideJobsPerDay?: number;
  now?: () => number;
};

const ED25519 = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export class RobService {
  private readonly config: RobConfig;
  private readonly ruggyPublicKey: string;
  private readonly shared: Array<{ publicKey: string; secretKey: string }> = [];
  private sharedTurn = 0;
  private readonly nonces = new Map<string, bigint>();
  private statsCache: { at: number; value: Awaited<ReturnType<RobService["computeStats"]>> } | null = null;
  /** Look Legit holds the Base wallet's single slot: one at a time. */
  private baseTurn: Promise<unknown> = Promise.resolve();
  /** Inside Jobs between their vote and their veto: the sweep leaves their rules to them. */
  private insideJobsRunning = 0;
  private bondCache: string | null = null;
  private readonly now: () => number;

  constructor(private readonly options: RobServiceOptions) {
    this.config = options.config;
    this.ruggyPublicKey = KeyPair.fromString(options.ruggySecretKey as Parameters<typeof KeyPair.fromString>[0]).getPublicKey().toString();
    this.now = options.now ?? Date.now;
  }

  cards() {
    const sample = { attacker: "0".repeat(64), reference: "sample", newKey: this.ruggyPublicKey };
    return {
      ruggy: this.config.ruggyAccountId,
      vault: this.config.vaultAccountId,
      dao: this.config.daoAccountId,
      suppliers: this.config.suppliers,
      token: this.config.token,
      role: this.config.role,
      laws: LAWS,
      // signer: "function-call" = your key (or a shared one), "ruggy" = Ruggy's own account, "none" = off chain.
      cards: CARDS.map((card) => ({ ...card, signer: card.playable ? cardCall(card, this.config, sample).signer : "none" })),
    };
  }

  clientHash(address: string): string {
    return createHash("sha256").update(`${this.options.clientSalt}:${address}`).digest("hex");
  }

  /** The player's own account: the implicit account of their key. */
  static attackerOf(publicKey: string): string {
    return Buffer.from(utils.PublicKey.fromString(publicKey).data).toString("hex");
  }

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------

  /** Make the shared keys (once per start). */
  async start(): Promise<void> {
    const count = this.options.sharedKeys ?? 3;
    const fresh = Array.from({ length: count }, () => KeyPair.fromRandom("ed25519"));
    await this.sendAsRuggy(this.config.ruggyAccountId, fresh.map((pair) => this.playerKeyAction(pair.getPublicKey().toString(), SHARED_METHODS, this.options.sharedKeyAllowanceYocto ?? "1000000000000000000000000")));
    for (const pair of fresh) {
      this.shared.push({ publicKey: pair.getPublicKey().toString(), secretKey: pair.toString() });
      await this.options.store.robKey.create({ data: { publicKey: pair.getPublicKey().toString(), kind: "shared", clientHash: "server" } });
    }
  }

  private playerKeyAction(publicKey: string, methodNames: string[] = PLAYER_METHODS, allowanceYocto?: string): RobAction {
    return {
      type: "AddFunctionCallKey",
      publicKey,
      receiverId: this.config.vaultAccountId,
      methodNames,
      allowanceYocto: allowanceYocto ?? this.options.keyAllowanceYocto ?? "250000000000000000000000",
    };
  }

  /** Add a key made in the player's browser to Ruggy's account, for 24 hours. */
  async session(publicKey: string, clientHash: string) {
    if (!ED25519.test(publicKey)) throw new RobError(400, "invalid_key", "publicKey must be an ed25519 key, ed25519:<base58>");
    const existing = await this.options.store.robKey.findUnique({ where: { publicKey } });
    if (existing && !existing.deletedAt) return this.sessionView(publicKey, existing.createdAt);
    if (existing) throw new RobError(409, "key_expired", "this key was already used and removed: make a new one");
    const active = await this.options.store.robKey.count({ where: { deletedAt: null, createdAt: { gt: new Date(this.now() - this.lifetime()) } } });
    if (active >= (this.options.maxActiveKeys ?? 300)) {
      throw new RobError(503, "arena_full", "too many players at once: play without a key of your own, or try again later");
    }
    await this.sendAsRuggy(this.config.ruggyAccountId, [this.playerKeyAction(publicKey)]);
    await this.options.store.robKey.create({ data: { publicKey, kind: "player", clientHash } });
    return this.sessionView(publicKey, new Date(this.now()));
  }

  private sessionView(publicKey: string, createdAt: Date) {
    return {
      accountId: this.config.ruggyAccountId,
      publicKey,
      vault: this.config.vaultAccountId,
      methods: PLAYER_METHODS,
      attacker: RobService.attackerOf(publicKey),
      expiresAt: new Date(createdAt.getTime() + this.lifetime()).toISOString(),
    };
  }

  private lifetime(): number {
    return this.options.keyLifetimeMs ?? 24 * 3_600_000;
  }

  private async activeKey(publicKey: string): Promise<void> {
    const row = await this.options.store.robKey.findUnique({ where: { publicKey } });
    if (!row || row.deletedAt || row.createdAt.getTime() < this.now() - this.lifetime()) {
      throw new RobError(403, "unknown_key", "this key is not on Ruggy's account: start a session first");
    }
  }

  /** Delete keys older than 24 hours, and keep the vault stocked with test tokens. */
  async maintain(): Promise<{ deleted: number; minted: boolean }> {
    const old = await this.options.store.robKey.findMany({
      where: { deletedAt: null, createdAt: { lt: new Date(this.now() - this.lifetime()) } },
      take: 50,
      orderBy: { createdAt: "asc" },
    });
    if (old.length) {
      const existing = await Promise.all(old.map((row) => this.options.rpc.accessKey(this.config.ruggyAccountId, row.publicKey)));
      const toDelete = old.filter((_, index) => existing[index]);
      if (toDelete.length) await this.sendAsRuggy(this.config.ruggyAccountId, toDelete.map((row) => ({ type: "DeleteKey", publicKey: row.publicKey })));
      await this.options.store.robKey.updateMany({ where: { publicKey: { in: old.map((row) => row.publicKey) } }, data: { deletedAt: new Date(this.now()) } });
    }
    let minted = false;
    const floor = this.options.vaultFloor ?? 15_000_000n;
    const balance = BigInt(await this.options.rpc.view<string>(this.config.token, "ft_balance_of", { account_id: this.config.vaultAccountId }));
    if (balance < floor) {
      // The test token's mint is open to anyone.
      await this.sendAsRuggy(this.config.token, [{ type: "FunctionCall", methodName: "mint", args: { account_id: this.config.vaultAccountId, amount: (floor * 2n - balance).toString() }, gasTgas: 10 }]);
      minted = true;
    }
    return { deleted: old.length, minted };
  }

  // ---------------------------------------------------------------------------
  // Playing
  // ---------------------------------------------------------------------------

  private playable(cardId: string): CardInfo {
    const card = cardById(cardId);
    if (!card) throw new RobError(404, "unknown_card", `no card ${cardId}: GET /v1/rob/cards`);
    if (!card.playable) throw new RobError(409, "card_not_open", `${card.title} is not open yet`);
    return card;
  }

  private callFor(card: CardInfo, attacker: string) {
    return cardCall(card, this.config, {
      attacker,
      reference: `rob-${this.now().toString(36)}-${randomBytes(4).toString("hex")}`,
      newKey: KeyPair.fromRandom("ed25519").getPublicKey().toString(),
    });
  }

  /**
   * The transaction a card makes, unsigned, for a player who signs with their own key.
   * Their browser signs `hash` and sends the signature back with /play.
   */
  async prepare(input: { card?: string; forge?: { method: string; args: Record<string, unknown> }; publicKey: string }) {
    await this.activeKey(input.publicKey);
    const attacker = RobService.attackerOf(input.publicKey);
    let receiverId: string;
    let actions: RobAction[];
    let label: string;
    if (input.forge) {
      ({ receiverId, actions } = this.forgeCall(input.forge));
      label = "forge";
    } else {
      const card = this.playable(input.card ?? "");
      const call = this.callFor(card, attacker);
      if (call.signer !== "function-call") throw new RobError(409, "not_signed_by_player", `${card.title} is played by the server: POST /v1/rob/play without a signature`);
      ({ receiverId, actions } = call);
      label = card.id;
    }
    const nonce = await this.nextNonce(input.publicKey, true);
    const { bytes, hash } = buildTransaction({ signerId: this.config.ruggyAccountId, publicKey: input.publicKey, receiverId, nonce, blockHash: await this.options.rpc.finalBlockHash(), actions });
    return { card: label, transaction: Buffer.from(bytes).toString("base64"), hash: Buffer.from(hash).toString("base64"), receiverId, actions };
  }

  private forgeCall(forge: { method: string; args: Record<string, unknown> }): { receiverId: string; actions: RobAction[] } {
    if (!/^[a-z_][a-z0-9_]{0,63}$/.test(forge.method)) throw new RobError(400, "invalid_method", "method must be a contract method name");
    if (JSON.stringify(forge.args ?? {}).length > 4_000) throw new RobError(400, "args_too_large", "args must be under 4 KB");
    return { receiverId: this.config.vaultAccountId, actions: [{ type: "FunctionCall", methodName: forge.method, args: forge.args ?? {}, gasTgas: EXECUTE_GAS_TGAS }] };
  }

  /** Play a card. With `signed` (a transaction the player signed, from /prepare), it is sent as is. */
  async play(input: { card: string; signed?: { transaction: string; signature: string }; clientHash: string }): Promise<PlayResult> {
    const card = this.playable(input.card);
    const started = this.now();
    if (card.id === "look-legit") return this.lookLegit(card, input.clientHash, started);
    if (card.id === "inside-job") return this.insideJob(card, input.clientHash, started);
    if (card.id === "bribe-ruggy") {
      // Off chain: Ruggy answers with the most his law allows.
      const result: PlayResult = {
        card: card.id, verdict: "counter", refusedBy: "ruggy", line: 1, error: null, tx: null, nearblocks: null,
        call: card.attempt, signedBy: "nobody: an offer, not a transaction", counter: { counter: 2, expires_in: 60, to: this.config.suppliers[0] }, ms: 0,
      };
      await this.record(result, null, input.clientHash);
      return result;
    }
    if (input.signed) {
      const { publicKey, signedBase64 } = this.playerSigned(input.signed);
      await this.activeKey(publicKey);
      const outcome = await this.options.rpc.send(signedBase64, this.config.ruggyAccountId);
      return this.finish(card, outcome, `your key ${short(publicKey)} on ${this.config.ruggyAccountId}`, publicKey, input.clientHash, started);
    }
    const shared = this.nextShared();
    const call = this.callFor(card, RobService.attackerOf(shared.publicKey));
    if (call.signer === "ruggy") {
      const outcome = await this.sendAsRuggy(call.receiverId, call.actions);
      return this.finish(card, outcome, `${this.config.ruggyAccountId} (his own account: a function-call key cannot reach the DAO)`, null, input.clientHash, started);
    }
    const outcome = await this.sendWithKey(shared, call.receiverId, call.actions);
    return this.finish(card, outcome, `a shared throwaway key ${short(shared.publicKey)} on ${this.config.ruggyAccountId}`, shared.publicKey, input.clientHash, started);
  }

  /** Expert mode: any method on the vault, signed by a function-call key. */
  async forge(input: { method: string; args: Record<string, unknown>; signed?: { transaction: string; signature: string }; clientHash: string }): Promise<PlayResult> {
    const started = this.now();
    const card: CardInfo = { id: "forge", numeral: "", title: "Forged call", rarity: "BRONZE", line: 0, by: "vault", attempt: `${input.method}(${JSON.stringify(input.args ?? {}).slice(0, 160)})`, why: "", playable: true };
    if (input.signed) {
      const { publicKey, signedBase64 } = this.playerSigned(input.signed);
      await this.activeKey(publicKey);
      const outcome = await this.options.rpc.send(signedBase64, this.config.ruggyAccountId);
      return this.finish(card, outcome, `your key ${short(publicKey)} on ${this.config.ruggyAccountId}`, publicKey, input.clientHash, started);
    }
    const shared = this.nextShared();
    const { receiverId, actions } = this.forgeCall(input);
    const outcome = await this.sendWithKey(shared, receiverId, actions);
    return this.finish(card, outcome, `a shared throwaway key ${short(shared.publicKey)} on ${this.config.ruggyAccountId}`, shared.publicKey, input.clientHash, started);
  }

  /** A transaction from /prepare and the player's signature over its hash. Only Ruggy's transactions are sent. */
  private playerSigned(signed: { transaction: string; signature: string }) {
    const bytes = Buffer.from(signed.transaction, "base64");
    let transaction: { signerId: string; publicKey: { ed25519Key?: { data: number[] } } };
    try {
      transaction = transactions.Transaction.decode(bytes) as unknown as typeof transaction;
    } catch {
      throw new RobError(400, "invalid_transaction", "transaction must be the base64 bytes /v1/rob/prepare returned");
    }
    if (transaction.signerId !== this.config.ruggyAccountId) throw new RobError(400, "not_ruggy", `only transactions signed on ${this.config.ruggyAccountId} are sent`);
    const signature = Buffer.from(signed.signature, "base64");
    if (signature.length !== 64) throw new RobError(400, "invalid_signature", "signature must be 64 bytes, base64");
    const keyData = transaction.publicKey.ed25519Key?.data;
    if (!keyData) throw new RobError(400, "invalid_key", "only ed25519 keys play");
    const key = new utils.PublicKey({ keyType: utils.key_pair.KeyType.ED25519, data: Uint8Array.from(keyData) });
    const hash = createHash("sha256").update(bytes).digest();
    if (!key.verify(hash, signature)) throw new RobError(400, "invalid_signature", "the signature does not match the transaction");
    // A signed transaction is the transaction's bytes, the key type (0: ed25519) and the 64-byte signature.
    const signedBase64 = Buffer.concat([bytes, Buffer.from([0]), signature]).toString("base64");
    return { publicKey: key.toString(), signedBase64 };
  }

  private nextShared() {
    if (!this.shared.length) throw new RobError(503, "not_ready", "the shared keys are not on Ruggy's account yet");
    const key = this.shared[this.sharedTurn % this.shared.length]!;
    this.sharedTurn += 1;
    return key;
  }

  private async nextNonce(publicKey: string, fresh = false, accountId = this.config.ruggyAccountId): Promise<bigint> {
    // Our own keys: count locally after the first read, and read again after a refusal.
    const local = this.nonces.get(publicKey);
    if (local !== undefined && !fresh) {
      this.nonces.set(publicKey, local + 1n);
      return local + 1n;
    }
    // A key added a moment ago can take a block or two to show on every RPC node.
    let onChain = await this.options.rpc.accessKey(accountId, publicKey);
    for (let attempt = 0; !onChain && attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      onChain = await this.options.rpc.accessKey(accountId, publicKey);
    }
    if (!onChain) throw new RobError(403, "unknown_key", "this key is not on Ruggy's account");
    // Read after the await: plays sent at the same time on one key get distinct nonces.
    const known = this.nonces.get(publicKey);
    const next = (known !== undefined && known >= BigInt(onChain.nonce) ? known : BigInt(onChain.nonce)) + 1n;
    this.nonces.set(publicKey, next);
    return next;
  }

  /** Sign and send; on a nonce race, once more with a fresh nonce. */
  private async sendWithKey(key: { publicKey: string; secretKey: string }, receiverId: string, actions: RobAction[], signerId = this.config.ruggyAccountId): Promise<Outcome> {
    for (let attempt = 0; ; attempt += 1) {
      const nonce = await this.nextNonce(key.publicKey, attempt > 0, signerId);
      const { transaction, hash } = buildTransaction({ signerId, publicKey: key.publicKey, receiverId, nonce, blockHash: await this.options.rpc.finalBlockHash(), actions });
      const outcome = await this.options.rpc.send(signWith(key.secretKey, transaction, hash), signerId);
      // Two plays on one key can reach NEAR in the other order: the later nonce wins, retry the other.
      if (outcome.kind === "rejected" && outcome.error === "InvalidNonce" && attempt < 3) continue;
      return outcome;
    }
  }

  /**
   * For the sections registered in extras.ts (Hire him): the game's accounts, its RPC, and Ruggy's
   * full key, on the same nonce counter as the cards (two signers of one key would race).
   */
  asRuggy() {
    return { config: this.config, rpc: this.options.rpc, send: (receiverId: string, actions: RobAction[]) => this.sendAsRuggy(receiverId, actions) };
  }

  private sendAsRuggy(receiverId: string, actions: RobAction[]): Promise<Outcome> {
    return this.sendWithKey({ publicKey: this.ruggyPublicKey, secretKey: this.options.ruggySecretKey }, receiverId, actions).then((outcome) => {
      if (receiverId === this.config.ruggyAccountId && outcome.kind !== "succeeded") {
        throw new RobError(503, "key_change_failed", `Ruggy's keys could not be changed: ${outcome.error}`);
      }
      return outcome;
    });
  }

  private async finish(card: CardInfo, outcome: Outcome, signedBy: string, publicKey: string | null, clientHash: string, started: number): Promise<PlayResult> {
    const result: PlayResult = {
      card: card.id,
      verdict: outcome.kind === "succeeded" ? "paid" : "denied",
      refusedBy: outcome.kind === "succeeded" ? null : outcome.kind === "rejected" ? "near" : defenderOf(card, outcome.error),
      line: outcome.kind === "succeeded" ? null : lawOf(card, outcome.error),
      error: outcome.kind === "succeeded" ? null : outcome.error,
      tx: outcome.kind === "rejected" ? null : outcome.tx,
      nearblocks: outcome.kind === "rejected" ? null : `https://testnet.nearblocks.io/txns/${outcome.tx}`,
      call: card.attempt,
      signedBy,
      ms: this.now() - started,
    };
    await this.record(result, publicKey, clientHash);
    this.statsCache = null;
    return result;
  }

  private async record(result: PlayResult, publicKey: string | null, clientHash: string) {
    await this.options.store.robPlay.create({
      data: { card: result.card, verdict: result.verdict, refusedBy: result.refusedBy ?? "none", error: result.error, tx: result.tx, publicKey, clientHash },
    });
  }

  // ---------------------------------------------------------------------------
  // The council: Look Legit, Inside Job, and the sweep
  // ---------------------------------------------------------------------------

  private owner(index: 0 | 1 | 2) {
    const owner = this.options.owners?.[index];
    if (!owner) throw new RobError(503, "not_configured", "this card needs the demo company's owners (ROB_OWNER_KEYS)");
    const publicKey = KeyPair.fromString(owner.secretKey as Parameters<typeof KeyPair.fromString>[0]).getPublicKey().toString();
    return { accountId: owner.accountId, key: { publicKey, secretKey: owner.secretKey } };
  }

  /** The council bot: the third owner signs a veto on the vault. */
  private veto(method: "veto_operation" | "veto_rule_change", args: Record<string, unknown>): Promise<Outcome> {
    const council = this.owner(2);
    return this.sendWithKey(council.key, this.config.vaultAccountId, [{ type: "FunctionCall", methodName: method, args, gasTgas: 30 }], council.accountId);
  }

  /**
   * Veto, and if the vault says it is no longer pending, read why: another council member (or
   * another instance's sweep) may have vetoed it first. Only a Vetoed state counts as vetoed.
   */
  private async vetoAndConfirm(kind: "operation" | "rule", id: number[]): Promise<{ vetoed: boolean; tx: string | null; by: string | null; outcome: Outcome }> {
    const outcome = await this.veto(kind === "operation" ? "veto_operation" : "veto_rule_change", kind === "operation" ? { op_id: id } : { queue_id: id });
    if (outcome.kind === "succeeded") return { vetoed: true, tx: outcome.tx, by: this.owner(2).accountId, outcome };
    if (!/ERR_RULE_NOT_QUEUED|ERR_OPERATION_NOT_VETOABLE/.test(outcome.error)) return { vetoed: false, tx: null, by: null, outcome };
    if (kind === "rule") {
      const rules = await this.options.rpc.view<Array<{ queue_id: number[]; state: string; vetoed_by: string | null }>>(this.config.vaultAccountId, "list_rule_changes", { before: null, limit: 50 });
      const rule = rules.find((item) => Buffer.from(item.queue_id).equals(Buffer.from(id)));
      if (rule?.state === "Vetoed") return { vetoed: true, tx: null, by: rule.vetoed_by, outcome };
    } else {
      const operation = await this.options.rpc.view<{ state: string } | null>(this.config.vaultAccountId, "get_operation", { op_id: id });
      if (operation?.state === "Vetoed") return { vetoed: true, tx: null, by: "the council", outcome };
    }
    return { vetoed: false, tx: null, by: null, outcome };
  }

  /**
   * X · Look Legit: a payment on Base that respects every rule, above the 1 USDC delay threshold.
   * prepare (lawful, reserved), authorize (queued: the wait starts, MPC signs nothing), then the
   * council bot vetoes it. One at a time: the Base wallet holds one operation.
   */
  private lookLegit(card: CardInfo, clientHash: string, started: number): Promise<PlayResult> {
    const run = this.baseTurn.then(() => this.lookLegitNow(card, clientHash, started));
    this.baseTurn = run.catch(() => undefined);
    return run;
  }

  private async lookLegitNow(card: CardInfo, clientHash: string, started: number): Promise<PlayResult> {
    const base = this.config.base;
    if (!base) throw new RobError(503, "not_configured", "Look Legit needs Ruggy's Base role");
    this.owner(2);
    const shared = this.nextShared();
    const reference = `rob-legit-${this.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const request = {
      chain_id: base.chainId,
      target: Array.from(hexToBytes(getAddress(base.token as Hex))),
      value: "0",
      calldata: Array.from(hexToBytes(encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(base.suppliers[0] as Hex), 2_000_000n] }))),
      allowance_amount: "2000000",
      reference,
      gas_limit: "100000",
      max_fee_per_gas: "2000000000",
      max_priority_fee_per_gas: "1000000000",
    };
    const signedBy = `a shared throwaway key ${short(shared.publicKey)} on ${this.config.ruggyAccountId}, then the council bot (${this.owner(2).accountId})`;
    const prepared = await this.sendWithKey(shared, this.config.vaultAccountId, [{ type: "FunctionCall", methodName: "prepare", args: { role: base.role, request }, gasTgas: 50 }]);
    if (prepared.kind !== "succeeded") return this.finish(card, prepared, signedBy, shared.publicKey, clientHash, started);
    const operation = JSON.parse(prepared.value ?? "{}") as { op_id?: number[]; execute_after_ns?: string | null };
    if (!operation.op_id) throw new RobError(503, "unexpected", "the vault did not return the operation");
    const steps: Step[] = [{ label: "LAWFUL", detail: "every rule passes: prepared", tx: prepared.tx }];
    // Queued, not signed: the operation is over the delay threshold (prepare set its wait).
    const authorized = await this.sendWithKey(shared, this.config.vaultAccountId, [{ type: "FunctionCall", methodName: "authorize", args: { op_id: operation.op_id, approval: null }, gasTgas: 30 }]);
    const queued = authorized.kind === "succeeded" && (authorized.logs ?? []).some((log) => log.startsWith("OMNIROLES_OPERATION_QUEUED:"));
    steps.push(queued
      ? { label: "SCHEDULED", detail: "over 1 USDC: it waits 10 minutes", tx: authorized.kind === "succeeded" ? authorized.tx : null }
      : { label: "NOT QUEUED", detail: `authorize: ${authorized.kind === "succeeded" ? "no wait logged" : authorized.error}`, tx: authorized.kind === "rejected" ? null : authorized.tx });
    const vetoed = await this.vetoAndConfirm("operation", operation.op_id);
    steps.push({ label: "UNSIGNED", detail: "MPC signs nothing during the wait", tx: null });
    return this.finishVeto(card, vetoed, steps, signedBy, shared.publicKey, clientHash, started, `prepare + authorize: 2 USDC on Base to ${base.suppliers[0].slice(0, 8)}…, reference ${reference}`);
  }

  /**
   * XI · Inside Job: two of the three owners (bribed: their keys are the game's) vote a rule that
   * adds the player to Ruggy's NEAR suppliers. The vote passes and the change waits in the vault's
   * queue; the council bot vetoes it at once, long before its veto window ends.
   */
  private async insideJob(card: CardInfo, clientHash: string, started: number): Promise<PlayResult> {
    const [bribed, accomplice] = [this.owner(0), this.owner(1)];
    this.owner(2);
    const day = new Date(this.now() - 24 * 3_600_000);
    if (await this.options.store.robPlay.count({ where: { card: card.id, clientHash, createdAt: { gt: day } } }) >= 1) {
      throw new RobError(429, "one_inside_job_a_day", "one Inside Job a day per player: it costs four real transactions");
    }
    if (await this.options.store.robPlay.count({ where: { card: card.id, createdAt: { gt: day } } }) >= (this.options.insideJobsPerDay ?? 100)) {
      throw new RobError(429, "inside_jobs_spent", "the owners have been bribed enough today: try again tomorrow");
    }
    // The player's name in the corrupted rule (it needs no account: the rule never applies).
    const attacker = `rob-thief-${clientHash.slice(0, 8)}.testnet`;
    const permissions = await this.options.rpc.view<Array<{ token: string; receivers: string[]; allowance: number[]; min_per_transfer: string; max_per_transfer: string }>>(this.config.vaultAccountId, "get_near_permissions", { role: this.config.role });
    const corrupted = permissions.map((permission, index) => (index === 0 ? { ...permission, receivers: [...permission.receivers, attacker] } : permission));
    const change = { SetNearPermissions: { role: this.config.role, permissions: corrupted } };
    const args = proposalArgs(this.config.vaultAccountId, `Rob the Agent · Inside Job: add ${attacker} to Ruggy's suppliers`, [{ method: "queue_rule_change", change: change as never }]);
    const signedBy = `${bribed.accountId} and ${accomplice.accountId} (bribed owners), then the council bot (${this.owner(2).accountId})`;
    const steps: Step[] = [];
    this.insideJobsRunning += 1;
    try {
      return await this.insideJobSteps(card, clientHash, started, { bribed, accomplice, attacker, args, signedBy, steps });
    } finally {
      this.insideJobsRunning -= 1;
    }
  }

  private async insideJobSteps(
    card: CardInfo,
    clientHash: string,
    started: number,
    input: { bribed: ReturnType<RobService["owner"]>; accomplice: ReturnType<RobService["owner"]>; attacker: string; args: ReturnType<typeof proposalArgs>; signedBy: string; steps: Step[] },
  ): Promise<PlayResult> {
    const { bribed, accomplice, attacker, args, signedBy, steps } = input;
    const proposed = await this.sendWithKey(bribed.key, this.config.daoAccountId, [{ type: "FunctionCall", methodName: "add_proposal", args, gasTgas: 150, depositYocto: await this.bond() }], bribed.accountId);
    if (proposed.kind !== "succeeded") return this.finish(card, proposed, signedBy, null, clientHash, started);
    const id = Number(proposed.value);
    steps.push({ label: "BRIBED", detail: `2 of 3 owners · proposal #${id}`, tx: proposed.tx });
    const proposal = await this.options.rpc.view<{ kind: unknown }>(this.config.daoAccountId, "get_proposal", { id });
    let voted: Outcome | null = null;
    for (const owner of [bribed, accomplice]) {
      voted = await this.sendWithKey(owner.key, this.config.daoAccountId, [{ type: "FunctionCall", methodName: "act_proposal", args: { id, action: "VoteApprove", proposal: proposal.kind, memo: null }, gasTgas: 250 }], owner.accountId);
      if (voted.kind !== "succeeded") return this.finish(card, voted, signedBy, null, clientHash, started);
    }
    const queued = (voted?.kind === "succeeded" ? voted.logs ?? [] : []).map((log) => /OMNIROLES_RULE_QUEUED:([0-9a-f]{64})/.exec(log)?.[1]).find(Boolean);
    steps.push({ label: "VOTED", detail: "proposal passed", tx: voted?.kind === "succeeded" ? voted.tx : null });
    if (!queued) throw new RobError(503, "unexpected", "the vote passed but the vault queued nothing");
    steps.push({ label: "QUEUED", detail: "veto window open", tx: null });
    const vetoed = await this.vetoAndConfirm("rule", Array.from(Buffer.from(queued, "hex")));
    return this.finishVeto(card, vetoed, steps, signedBy, null, clientHash, started, `2 of 3 owners vote: add ${attacker} to Ruggy's suppliers`);
  }

  private async bond(): Promise<string> {
    this.bondCache ??= (await this.options.rpc.view<{ proposal_bond: string }>(this.config.daoAccountId, "get_policy")).proposal_bond;
    return this.bondCache;
  }

  private async finishVeto(
    card: CardInfo,
    vetoed: { vetoed: boolean; tx: string | null; by: string | null; outcome: Outcome },
    steps: Step[],
    signedBy: string,
    publicKey: string | null,
    clientHash: string,
    started: number,
    call: string,
  ): Promise<PlayResult> {
    if (!vetoed.vetoed) {
      // The sweep retries at once; the play reports what the chain answered.
      void this.sweep().catch((error: unknown) => console.warn(`rob council sweep: ${String(error)}`));
      return this.finish(card, vetoed.outcome, signedBy, publicKey, clientHash, started);
    }
    steps.push({ label: "VETOED", detail: vetoed.tx ? "by the council" : `already, by ${vetoed.by ?? "the council"}`, tx: vetoed.tx });
    const result: PlayResult = {
      card: card.id, verdict: "vetoed", refusedBy: "council", line: card.line, error: card.id === "look-legit" ? "VETOED · veto_operation" : "VETOED · veto_rule_change",
      tx: vetoed.tx, nearblocks: vetoed.tx ? `https://testnet.nearblocks.io/txns/${vetoed.tx}` : null, call, signedBy, steps, ms: this.now() - started,
    };
    await this.record(result, publicKey, clientHash);
    this.statsCache = null;
    return result;
  }

  /**
   * The council bot's sweep: veto every rule change still in the queue and Ruggy's Base operation
   * still waiting. Nothing the game opens may outlive its veto window, even after a crash.
   */
  async sweep(): Promise<{ rules: number; operations: number }> {
    if (!this.options.owners?.[2]) return { rules: 0, operations: 0 };
    let rules = 0;
    let operations = 0;
    const queued = await this.options.rpc.view<Array<{ queue_id: number[]; state: string }>>(this.config.vaultAccountId, "list_rule_changes", { before: null, limit: 50 });
    // An Inside Job in progress vetoes its own rule; the next sweep catches it if that fails.
    if (this.insideJobsRunning === 0) {
      for (const rule of queued.filter((item) => item.state === "Queued")) {
        if ((await this.veto("veto_rule_change", { queue_id: rule.queue_id })).kind === "succeeded") rules += 1;
      }
    }
    if (this.config.base) {
      const wallet = await this.options.rpc.view<{ active_operation: number[] | null } | null>(this.config.vaultAccountId, "get_wallet", { chain_id: this.config.base.chainId });
      if (wallet?.active_operation) {
        const operation = await this.options.rpc.view<{ member: string; state: string } | null>(this.config.vaultAccountId, "get_operation", { op_id: wallet.active_operation });
        if (operation && operation.member === this.config.ruggyAccountId && ["Prepared", "Queued", "Scheduled"].includes(operation.state)) {
          // Not while Look Legit is between its own steps: it vetoes its operation itself.
          let idle = false;
          await Promise.race([this.baseTurn.then(() => { idle = true; }), new Promise((resolve) => setTimeout(resolve, 0))]);
          if (idle && (await this.veto("veto_operation", { op_id: wallet.active_operation })).kind === "succeeded") operations += 1;
        }
      }
    }
    if (rules || operations) console.warn(`rob council sweep vetoed ${rules} rule(s), ${operations} operation(s)`);
    return { rules, operations };
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  async stats() {
    if (this.statsCache && this.now() - this.statsCache.at < 10_000) return this.statsCache.value;
    const value = await this.computeStats();
    this.statsCache = { at: this.now(), value };
    return value;
  }

  private async computeStats() {
    const [attacks, denied, lawful, players] = await Promise.all([
      this.options.store.robPlay.count(),
      this.options.store.robPlay.count({ where: { verdict: "denied" } }),
      this.options.store.robPlay.count({ where: { verdict: "paid" } }),
      this.options.store.robPlay.groupBy({ by: ["clientHash"] }).then((groups) => groups.length),
    ]);
    // The vault pays only its two listed suppliers (accounts of ours): nothing can leave elsewhere.
    return { attacks, players, denied, lawfulPayments: lawful, linesOfDefense: 3, stolen: 0 };
  }
}

function short(publicKey: string): string {
  const body = publicKey.replace(/^ed25519:/, "");
  return `ed25519:${body.slice(0, 4)}…${body.slice(-3)}`;
}

/** Which law answered, from the refusal itself. */
export function lawOf(card: CardInfo, error: string): number {
  if (/FunctionNotAllowed|TokenNotAllowed|ERR_SELF_TRANSFER/.test(error)) return 0;
  if (/ERR_MIN_PER_TRANSFER|ERR_MAX_PER_TRANSFER|ERR_ZERO_AMOUNT/.test(error)) return 1;
  if (/ERR_ALLOWANCE_EXCEEDED/.test(error)) return 2;
  if (/ERR_REFERENCE_ALREADY_USED/.test(error)) return 3;
  if (/ERR_OWNER_ONLY|ERR_PERMISSION_DENIED$/.test(error)) return 6;
  if (/RequiresFullAccess/.test(error)) return card.id === "forge-a-master-key" ? 5 : 4;
  return card.line;
}

function defenderOf(card: CardInfo, error: string): Defender {
  if (card.id === "crown-yourself") return "dao";
  if (/^ERR_|FunctionNotAllowed|TokenNotAllowed/.test(error)) return "vault";
  return card.by;
}

export { hashOfSigned };
