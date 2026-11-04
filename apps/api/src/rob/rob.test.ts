import { createHash } from "node:crypto";

import { KeyPair, transactions, utils } from "near-api-js";
import { describe, expect, it } from "vitest";

import { CARDS, cardById, cardCall, type RobConfig } from "./cards.js";
import { failureReason, outcomeOf, rejectionReason, type NearRpc, type Outcome } from "./near-tx.js";
import { lawOf, RobError, RobService, type RobStore } from "./service.js";

const config: RobConfig = {
  ruggyAccountId: "ruggy.testnet",
  vaultAccountId: "rob.nomos.testnet",
  daoAccountId: "rob.sputnik.testnet",
  token: "usdc.testnet",
  suppliers: ["supplier-a.testnet", "supplier-b.testnet"],
  role: "payments",
  seedReference: "rob-seed-1",
  base: { role: "base-payments", chainId: 84532, token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", suppliers: ["0x770FEe7954f3FC813AD65d33dAb0D9cc696a2702", "0xd63f3e36Dd87e8f8d480Bfe8093b708887156595"] },
};
const ruggy = KeyPair.fromRandom("ed25519");
const owners = ["owner1.testnet", "owner2.testnet", "owner3.testnet"].map((accountId) => ({ accountId, secretKey: KeyPair.fromRandom("ed25519").toString() }));
const QUEUE = "ab".repeat(32);
/** Method name of a transaction's first call, and its JSON args. */
function callOf(signed: transactions.SignedTransaction) {
  const call = signed.transaction.actions[0]!.functionCall;
  return { method: call?.methodName ?? "", args: call ? JSON.parse(Buffer.from(call.args).toString("utf8")) as Record<string, unknown> : {}, signer: signed.transaction.signerId };
}
const BLOCK = utils.serialize.base_encode(new Uint8Array(32).fill(7));

function fakes(answer: (signed: transactions.SignedTransaction) => Outcome = () => ({ kind: "failed", tx: "TX", error: "ERR_PERMISSION_DENIED:FunctionNotAllowed" })) {
  const sent: transactions.SignedTransaction[] = [];
  const keys = new Map<string, { publicKey: string; kind: string; clientHash: string; createdAt: Date; deletedAt: Date | null }>();
  const plays: Array<Record<string, unknown>> = [];
  const views: Record<string, unknown> = {
    get_policy: { proposal_bond: "100000000000000000000000" },
    get_proposal: { kind: { FunctionCall: {} } },
    get_near_permissions: [{ token: "usdc.testnet", receivers: ["supplier-a.testnet", "supplier-b.testnet"], allowance: [1], min_per_transfer: "100000", max_per_transfer: "2000000" }],
    list_rule_changes: [],
    get_wallet: { active_operation: null },
  };
  const rpc = {
    accessKey: async () => ({ nonce: 10, block_hash: BLOCK }),
    finalBlockHash: async () => BLOCK,
    view: async (_account: string, method: string) => views[method] ?? "20000000",
    send: async (signedBase64: string) => {
      const signed = transactions.SignedTransaction.decode(Buffer.from(signedBase64, "base64"));
      sent.push(signed);
      const action = signed.transaction.actions[0]!;
      if (action.addKey && action.addKey.accessKey.permission.functionCall) return { kind: "succeeded", tx: "KEY", value: null };
      return answer(signed);
    },
  } as unknown as NearRpc;
  const store: RobStore = {
    robKey: {
      findUnique: async ({ where }) => keys.get(where.publicKey) ?? null,
      count: async () => [...keys.values()].filter((key) => !key.deletedAt && key.kind === "player").length,
      create: async ({ data }) => keys.set(data.publicKey, { ...data, createdAt: new Date(), deletedAt: null }),
      findMany: async () => [],
      updateMany: async () => undefined,
    },
    robPlay: {
      create: async ({ data }) => plays.push(data),
      count: async (args) => plays.filter((play) => (!args?.where?.verdict || play.verdict === args.where.verdict) && (!args?.where?.card || play.card === args.where.card) && (!args?.where?.clientHash || play.clientHash === args.where.clientHash)).length,
      groupBy: async () => [...new Set(plays.map((play) => play.clientHash))],
    },
  };
  const service = new RobService({ config, rpc, store, ruggySecretKey: ruggy.toString(), clientSalt: "salt", maxActiveKeys: 2, sharedKeys: 1, owners });
  return { service, sent, keys, plays, views };
}

describe("cards", () => {
  const input = { attacker: "ab".repeat(32), reference: "rob-x", newKey: KeyPair.fromRandom("ed25519").getPublicKey().toString() };
  const request = (id: string) => {
    const call = cardCall(cardById(id)!, config, input);
    const action = call.actions[0];
    return { call, args: action?.type === "FunctionCall" ? (action.args as { request?: { receiver_id: string; amount: string; reference: string } }) : null };
  };

  it("eleven cards, nine open, each aimed at one law", () => {
    expect(CARDS).toHaveLength(11);
    expect(CARDS.filter((card) => card.playable).map((card) => card.numeral)).toEqual(["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"]);
  });

  it("each card makes the call it says", () => {
    expect(request("pay-the-attacker").args!.request).toMatchObject({ receiver_id: input.attacker, amount: "2000000" });
    expect(request("split-into-100").args!.request).toMatchObject({ receiver_id: "supplier-a.testnet", amount: "10000" });
    expect(request("overpriced-supplier").args!.request).toMatchObject({ receiver_id: "supplier-a.testnet", amount: "20000000" });
    expect(request("replay-the-cheque").args!.request).toMatchObject({ amount: "100000", reference: "rob-seed-1" });
    expect(request("steal-the-gas").call.actions[0]).toMatchObject({ type: "Transfer" });
    expect(request("forge-a-master-key").call).toMatchObject({ receiverId: "ruggy.testnet", actions: [{ type: "AddFullAccessKey" }] });
    expect(request("rewrite-the-law").call.actions[0]).toMatchObject({ methodName: "queue_rule_change" });
    expect(request("crown-yourself").call).toMatchObject({ signer: "ruggy", receiverId: "rob.sputnik.testnet" });
    expect(request("bribe-ruggy").call.signer).toBe("none");
  });

  it("names the law from the refusal itself", () => {
    const card = cardById("pay-the-attacker")!;
    expect(lawOf(card, "ERR_PERMISSION_DENIED:FunctionNotAllowed")).toBe(0);
    expect(lawOf(card, "ERR_PERMISSION_DENIED:ERR_MIN_PER_TRANSFER")).toBe(1);
    expect(lawOf(card, "ERR_ALLOWANCE_EXCEEDED")).toBe(2);
    expect(lawOf(card, "ERR_REFERENCE_ALREADY_USED")).toBe(3);
    expect(lawOf(cardById("steal-the-gas")!, "RequiresFullAccess")).toBe(4);
    expect(lawOf(cardById("forge-a-master-key")!, "RequiresFullAccess")).toBe(5);
    expect(lawOf(card, "ERR_OWNER_ONLY")).toBe(6);
    expect(lawOf(cardById("crown-yourself")!, "ERR_PERMISSION_DENIED")).toBe(6);
  });
});

describe("NEAR answers", () => {
  it("reads a contract panic and a refusal before the chain", () => {
    expect(failureReason({ ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_OWNER_ONLY" } } } })).toBe("ERR_OWNER_ONLY");
    expect(failureReason({ ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: panicked at 'ERR_PERMISSION_DENIED', sputnikdao2/src/proposals.rs:518:9" } } } })).toBe("ERR_PERMISSION_DENIED");
    expect(rejectionReason({ name: "HANDLER_ERROR", data: { TxExecutionError: { InvalidTxError: { InvalidAccessKeyError: "RequiresFullAccess" } } } })).toBe("RequiresFullAccess");
    expect(outcomeOf("T", { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_PERMISSION_DENIED:ERR_MAX_PER_TRANSFER" } } } } } } }] }))
      .toMatchObject({ kind: "failed", tx: "T", error: "ERR_PERMISSION_DENIED:ERR_MAX_PER_TRANSFER" });
  });
});

describe("RobService", () => {
  it("adds a player's key as a function-call key on the vault only, with a gas cap", async () => {
    const { service, sent } = fakes(() => ({ kind: "succeeded", tx: "T", value: null }));
    const player = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const session = await service.session(player, "c1");
    expect(session).toMatchObject({ accountId: "ruggy.testnet", vault: "rob.nomos.testnet", methods: ["execute_near", "queue_rule_change"] });
    const tx = sent[0]!.transaction;
    expect(tx.signerId).toBe("ruggy.testnet");
    expect(tx.receiverId).toBe("ruggy.testnet");
    const permission = tx.actions[0]!.addKey!.accessKey.permission.functionCall!;
    expect(permission.receiverId).toBe("rob.nomos.testnet");
    expect(permission.methodNames).toEqual(["execute_near", "queue_rule_change"]);
    expect(BigInt(permission.allowance!.toString())).toBe(250_000_000_000_000_000_000_000n);
  });

  it("refuses malformed keys and caps the keys alive at once", async () => {
    const { service } = fakes(() => ({ kind: "succeeded", tx: "T", value: null }));
    await expect(service.session("ed25519:nope", "c")).rejects.toMatchObject({ code: "invalid_key" });
    await service.session(KeyPair.fromRandom("ed25519").getPublicKey().toString(), "c");
    await service.session(KeyPair.fromRandom("ed25519").getPublicKey().toString(), "c");
    await expect(service.session(KeyPair.fromRandom("ed25519").getPublicKey().toString(), "c")).rejects.toMatchObject({ code: "arena_full", status: 503 });
  });

  it("reports the vault's refusal and records the play", async () => {
    const { service, plays } = fakes(() => ({ kind: "failed", tx: "TX1", error: "ERR_PERMISSION_DENIED:FunctionNotAllowed" }));
    await service.start();
    const result = await service.play({ card: "pay-the-attacker", clientHash: "c" });
    expect(result).toMatchObject({ verdict: "denied", refusedBy: "vault", line: 0, tx: "TX1", nearblocks: "https://testnet.nearblocks.io/txns/TX1" });
    expect(plays).toHaveLength(1);
    expect((await service.stats()).stolen).toBe(0);
  });

  it("shows no transaction when NEAR refuses before the chain", async () => {
    const { service } = fakes(() => ({ kind: "rejected", error: "RequiresFullAccess" }));
    await service.start();
    const result = await service.play({ card: "forge-a-master-key", clientHash: "c" });
    expect(result).toMatchObject({ verdict: "denied", refusedBy: "near", line: 5, tx: null, nearblocks: null });
  });

  it("answers a bribe off chain, and keeps closed cards closed", async () => {
    const { service, sent } = fakes();
    expect(await service.play({ card: "bribe-ruggy", clientHash: "c" })).toMatchObject({ verdict: "counter", counter: { counter: 2, expires_in: 60 } });
    expect(sent).toHaveLength(0);
    await expect(service.play({ card: "nope", clientHash: "c" })).rejects.toBeInstanceOf(RobError);
  });

  it("sends a player's own signature, and only on Ruggy's account", async () => {
    const { service, sent } = fakes(() => ({ kind: "failed", tx: "TX2", error: "ERR_PERMISSION_DENIED:ERR_MAX_PER_TRANSFER" }));
    await service.start();
    const player = KeyPair.fromRandom("ed25519");
    await service.session(player.getPublicKey().toString(), "c");
    const prepared = await service.prepare({ card: "overpriced-supplier", publicKey: player.getPublicKey().toString() });
    const hash = Buffer.from(prepared.hash, "base64");
    expect(createHash("sha256").update(Buffer.from(prepared.transaction, "base64")).digest().equals(hash)).toBe(true);
    const signature = Buffer.from(player.sign(hash).signature).toString("base64");
    const result = await service.play({ card: "overpriced-supplier", signed: { transaction: prepared.transaction, signature }, clientHash: "c" });
    expect(result).toMatchObject({ verdict: "denied", line: 1, tx: "TX2" });
    expect(Buffer.from(sent.at(-1)!.transaction.publicKey.ed25519Key!.data).equals(Buffer.from(player.getPublicKey().data))).toBe(true);
    // A signature from another key does not match.
    const other = Buffer.from(KeyPair.fromRandom("ed25519").sign(hash).signature).toString("base64");
    await expect(service.play({ card: "overpriced-supplier", signed: { transaction: prepared.transaction, signature: other }, clientHash: "c" })).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("plays Crown Yourself from Ruggy's account, with the DAO's refusal", async () => {
    const { service, sent } = fakes(() => ({ kind: "failed", tx: "TX3", error: "ERR_PERMISSION_DENIED" }));
    await service.start();
    const result = await service.play({ card: "crown-yourself", clientHash: "c" });
    expect(result).toMatchObject({ refusedBy: "dao", line: 6 });
    expect(sent.at(-1)!.transaction.receiverId).toBe("rob.sputnik.testnet");
    expect(Buffer.from(sent.at(-1)!.transaction.publicKey.ed25519Key!.data).equals(Buffer.from(ruggy.getPublicKey().data))).toBe(true);
  });

  it("Look Legit: a lawful Base payment is prepared, queued by its delay, then vetoed by the council", async () => {
    const { service, sent } = fakes((signed) => {
      const { method } = callOf(signed);
      if (method === "prepare") return { kind: "succeeded", tx: "PREP", value: JSON.stringify({ op_id: [7, 7], execute_after_ns: "1" }) };
      return { kind: "succeeded", tx: method.toUpperCase(), value: null };
    });
    await service.start();
    const result = await service.play({ card: "look-legit", clientHash: "c" });
    const calls = sent.slice(1).map(callOf);
    expect(calls.map((call) => call.method)).toEqual(["prepare", "authorize", "veto_operation"]);
    expect(calls[0]!.args).toMatchObject({ role: "base-payments", request: { chain_id: 84532, allowance_amount: "2000000" } });
    // The veto is the council's: the third owner signs it, nobody calls execute_queued_operation.
    expect(calls[2]).toMatchObject({ signer: "owner3.testnet", args: { op_id: [7, 7] } });
    expect(result).toMatchObject({ verdict: "vetoed", refusedBy: "council", line: 7, tx: "VETO_OPERATION" });
    expect(result.steps!.map((step) => step.label)).toEqual(["LAWFUL", "SCHEDULED", "UNSIGNED", "VETOED"]);
  });

  it("Inside Job: two owners vote a bad rule, the council vetoes it before anyone can apply it, once a day", async () => {
    const { service, sent } = fakes((signed) => {
      const { method } = callOf(signed);
      if (method === "add_proposal") return { kind: "succeeded", tx: "PROPOSE", value: "5" };
      if (method === "act_proposal") return { kind: "succeeded", tx: `VOTE-${signed.transaction.signerId}`, value: null, logs: [`OMNIROLES_RULE_QUEUED:${QUEUE}`] };
      return { kind: "succeeded", tx: method.toUpperCase(), value: null };
    });
    await service.start();
    const result = await service.play({ card: "inside-job", clientHash: "c" });
    const calls = sent.slice(1).map(callOf);
    expect(calls.map((call) => `${call.signer}:${call.method}`)).toEqual([
      "owner1.testnet:add_proposal", "owner1.testnet:act_proposal", "owner2.testnet:act_proposal", "owner3.testnet:veto_rule_change",
    ]);
    expect(calls.some((call) => call.method === "execute_rule_change")).toBe(false);
    expect(calls[3]!.args).toEqual({ queue_id: Array.from(Buffer.from(QUEUE, "hex")) });
    const proposal = calls[0]!.args as { proposal: { kind: { FunctionCall: { actions: Array<{ args: string }> } } } };
    const change = JSON.parse(atob(proposal.proposal.kind.FunctionCall.actions[0]!.args)) as { change: { SetNearPermissions: { permissions: Array<{ receivers: string[] }> } } };
    expect(change.change.SetNearPermissions.permissions[0]!.receivers).toContain(`rob-thief-${"c".slice(0, 8)}.testnet`);
    expect(result).toMatchObject({ verdict: "vetoed", refusedBy: "council", line: 6, tx: "VETO_RULE_CHANGE" });
    expect(result.steps!.map((step) => step.label)).toEqual(["BRIBED", "VOTED", "QUEUED", "VETOED"]);
    await expect(service.play({ card: "inside-job", clientHash: "c" })).rejects.toMatchObject({ code: "one_inside_job_a_day" });
  });

  it("the council sweep vetoes any queued rule and Ruggy's waiting Base operation", async () => {
    const { service, sent, views } = fakes(() => ({ kind: "succeeded", tx: "VETO", value: null }));
    views.list_rule_changes = [{ queue_id: [1], state: "Queued" }, { queue_id: [2], state: "Vetoed" }, { queue_id: [3], state: "Executed" }];
    views.get_wallet = { active_operation: [9] };
    views.get_operation = { member: "ruggy.testnet", state: "Queued" };
    expect(await service.sweep()).toEqual({ rules: 1, operations: 1 });
    expect(sent.map(callOf).map((call) => `${call.signer}:${call.method}:${JSON.stringify(call.args)}`)).toEqual([
      'owner3.testnet:veto_rule_change:{"queue_id":[1]}',
      'owner3.testnet:veto_operation:{"op_id":[9]}',
    ]);
  });
});
