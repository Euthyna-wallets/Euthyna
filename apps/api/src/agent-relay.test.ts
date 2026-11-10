import { KeyPair } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { callOutcome, relayedCall } from "@euthyna/sdk";

import { AgentRelay } from "./agent-relay.js";
import { decodeCheque } from "./market/cheque.js";

const AGENT = { nearAccountId: "bot-agent.mandateos.testnet", vaultAccountId: "co.euthyna-nomos.testnet" };
const outcome = (receiverId: string) => ({
  transaction_outcome: { id: "TX" },
  status: { SuccessValue: "" },
  receipts_outcome: [
    { id: "R1", outcome: { executor_id: AGENT.nearAccountId, logs: [], receipt_ids: ["R2"], status: { SuccessValue: "" } } },
    { id: "R2", outcome: { executor_id: receiverId, logs: ["EVENT"], receipt_ids: ["R3"], status: { SuccessReceiptId: "R3" } } },
    { id: "R3", outcome: { executor_id: receiverId, logs: [], receipt_ids: [], status: { SuccessValue: Buffer.from(JSON.stringify({ op_id: [1], state: "Pending" })).toString("base64") } } },
  ],
});

/** Signs a delegate the way the SDK does, against a stubbed RPC; returns it. */
async function sign(keyPair: KeyPair, receiverId: string, methodName = "prepare"): Promise<string> {
  let captured = "";
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body) as { method: string };
    return new Response(JSON.stringify({ result: method === "block" ? { header: { height: 1000 } } : { nonce: 41, permission: {} } }));
  });
  await relayedCall({
    rpcUrl: "http://rpc", senderId: AGENT.nearAccountId, keyPair, receiverId, methodName, args: { role: "desk" }, gas: 100_000_000_000_000n,
    relay: async (signed) => { captured = signed; return null; },
  });
  return captured;
}

afterEach(() => vi.unstubAllGlobals());

describe("agent calls relayed by Euthyna (NEP-366)", () => {
  it("the SDK's delegate is what the API decodes: sender, receiver, method, nonce, signature", async () => {
    const keyPair = KeyPair.fromRandom("ed25519");
    const decoded = decodeCheque(await sign(keyPair, AGENT.vaultAccountId));
    expect(decoded).toMatchObject({
      senderId: AGENT.nearAccountId, receiverId: AGENT.vaultAccountId, methodName: "prepare", args: { role: "desk" },
      nonce: 42n, maxBlockHeight: 1120n, deposit: 0n, actionCount: 1, signatureValid: true, publicKey: keyPair.getPublicKey().toString(),
    });
  });

  it("relays calls to the agent's vault and the sealed-orders contract only", async () => {
    const keyPair = KeyPair.fromRandom("ed25519");
    const sent: string[] = [];
    const relay = new AgentRelay({ relayDelegate: async (senderId) => { sent.push(senderId); return outcome(AGENT.vaultAccountId); } }, { sealedOrdersId: "sealed.testnet", perAgentPerDay: 2, totalPerDay: 10 });
    await expect(relay.relay(AGENT, await sign(keyPair, AGENT.vaultAccountId))).resolves.toMatchObject({ receiverId: AGENT.vaultAccountId });
    await expect(relay.relay(AGENT, await sign(keyPair, "sealed.testnet", "seal"))).resolves.toMatchObject({ receiverId: "sealed.testnet" });
    await expect(relay.relay(AGENT, await sign(keyPair, "other.testnet"))).rejects.toMatchObject({ code: "delegate_receiver" });
    await expect(relay.relay({ ...AGENT, nearAccountId: "someone.testnet" }, await sign(keyPair, AGENT.vaultAccountId))).rejects.toMatchObject({ code: "delegate_sender" });
    // Quota: two a day for this agent.
    await expect(relay.relay(AGENT, await sign(keyPair, AGENT.vaultAccountId))).rejects.toMatchObject({ status: 429 });
    await expect(relay.relay(AGENT, "not-a-delegate")).rejects.toMatchObject({ code: "delegate_malformed" });
    expect(sent).toEqual([AGENT.nearAccountId, AGENT.nearAccountId]);
  });

  it("a tampered delegate is refused before anything is sent", async () => {
    const keyPair = KeyPair.fromRandom("ed25519");
    const bytes = Buffer.from(await sign(keyPair, AGENT.vaultAccountId), "base64");
    bytes[bytes.length - 1] ^= 1;
    const relay = new AgentRelay({ relayDelegate: async () => { throw new Error("sent"); } }, { sealedOrdersId: null, perAgentPerDay: 5, totalPerDay: 5 });
    await expect(relay.relay(AGENT, bytes.toString("base64"))).rejects.toMatchObject({ code: "delegate_signature" });
  });

  it("the call's outcome is the receipt on the receiver, followed to its value", () => {
    const call = callOutcome(outcome(AGENT.vaultAccountId), AGENT.nearAccountId, AGENT.vaultAccountId);
    expect(JSON.parse(Buffer.from((call.status as { SuccessValue: string }).SuccessValue, "base64").toString())).toEqual({ op_id: [1], state: "Pending" });
    const failed = outcome(AGENT.vaultAccountId);
    failed.receipts_outcome[1]!.outcome.status = { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_PERMISSION_DENIED:TargetNotAllowed" } } } } } as never;
    expect(JSON.stringify(callOutcome(failed, AGENT.nearAccountId, AGENT.vaultAccountId).status)).toContain("ERR_PERMISSION_DENIED");
  });
});
