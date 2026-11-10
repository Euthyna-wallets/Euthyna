/**
 * An agent's call sent as a NEP-366 delegate: the agent signs, Euthyna's relayer sends it and pays
 * the gas. The agent's account then only needs its storage. When the API does not relay (off,
 * quota reached, no API key), the agent sends the call itself, as before.
 */
import type { KeyPair } from "near-api-js";

import { delegateSigningHash, encodeDelegateAction } from "./cheque.js";
import { base58Decode } from "./solana.js";

export type RelayOutcome = {
  transaction_outcome: { id: string };
  receipts_outcome: Array<{ id: string; outcome: { executor_id: string; logs: string[]; receipt_ids: string[]; status: unknown } }>;
  status: unknown;
};

/** Sends a signed delegate (base64 borsh); null when the API did not send it (the agent sends it itself). */
export type DelegateRelay = (signedDelegate: string) => Promise<RelayOutcome | null>;

async function rpc<T>(url: string, method: string, params: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "relay", method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json() as { result?: T & { error?: string }; error?: { message?: string } };
  if (!body.result || body.result.error) throw new Error(`NEAR RPC ${method}: ${body.result?.error ?? body.error?.message ?? response.status}`);
  return body.result;
}

/**
 * The relayed transaction's status says nothing of the call (a delegate receipt returns nothing):
 * the call's own outcome is the receipt on `receiverId` the delegate created, followed to its end.
 */
export function callOutcome(outcome: RelayOutcome, senderId: string, receiverId: string): RelayOutcome {
  const byId = new Map(outcome.receipts_outcome.map((item) => [item.id, item]));
  const delegate = outcome.receipts_outcome.find((item) => item.outcome.executor_id === senderId);
  const callId = delegate?.outcome.receipt_ids.find((id) => byId.get(id)?.outcome.executor_id === receiverId);
  if (!callId) {
    // The delegate itself failed (a used nonce, a key that may not make this call).
    const failure = delegate?.outcome.status ?? outcome.status;
    return { ...outcome, status: failure && typeof failure === "object" && "Failure" in failure ? failure : { Failure: { delegate: "the call was not made" } } };
  }
  let status = byId.get(callId)!.outcome.status;
  for (let depth = 0; depth < 16 && status && typeof status === "object" && "SuccessReceiptId" in status; depth += 1) {
    const next = byId.get(String((status as { SuccessReceiptId: string }).SuccessReceiptId));
    if (!next) break;
    status = next.outcome.status;
  }
  return { ...outcome, status };
}

/** Signs one function call as a delegate and has it relayed; null when not relayed. Throws when the call failed. */
export async function relayedCall(input: {
  rpcUrl: string;
  senderId: string;
  keyPair: KeyPair;
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: bigint;
  relay: DelegateRelay;
}): Promise<RelayOutcome | null> {
  const publicKey = input.keyPair.getPublicKey().toString();
  // "optimistic": the nonce right after this key's previous call, not a few blocks behind.
  const [key, block] = await Promise.all([
    rpc<{ nonce: number | string }>(input.rpcUrl, "query", { request_type: "view_access_key", finality: "optimistic", account_id: input.senderId, public_key: publicKey }),
    rpc<{ header: { height: number } }>(input.rpcUrl, "block", { finality: "final" }),
  ]);
  const delegate = encodeDelegateAction({
    senderId: input.senderId,
    receiverId: input.receiverId,
    methodName: input.methodName,
    args: new TextEncoder().encode(JSON.stringify(input.args)),
    gas: input.gas,
    deposit: 0n,
    nonce: BigInt(key.nonce) + 1n,
    maxBlockHeight: BigInt(block.header.height) + 120n,
    publicKey: base58Decode(publicKey.slice("ed25519:".length)),
  });
  const { signature } = input.keyPair.sign(delegateSigningHash(delegate));
  const signed = new Uint8Array(delegate.length + 1 + 64);
  signed.set(delegate, 0);
  signed[delegate.length] = 0;
  signed.set(signature, delegate.length + 1);
  let text = "";
  for (const byte of signed) text += String.fromCharCode(byte);
  const outcome = await input.relay(btoa(text));
  if (!outcome) return null;
  const call = callOutcome(outcome, input.senderId, input.receiverId);
  if (call.status && typeof call.status === "object" && "Failure" in call.status) {
    throw new Error(`relayed ${input.methodName} failed (${outcome.transaction_outcome.id}): ${JSON.stringify(call.status.Failure)}`);
  }
  return call;
}
