/** Test helper: real NEP-366 cheques signed like a NEAR wallet signs them. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { KeyPair, transactions } from "near-api-js";

import type { PaymentRequirement } from "./cheque.js";

const nearRequire = createRequire(createRequire(import.meta.url).resolve("near-api-js"));
const t = nearRequire("@near-js/transactions") as {
  buildDelegateAction(input: unknown): unknown;
  signDelegateAction(input: unknown): Promise<{ signedDelegateAction: unknown }>;
  encodeSignedDelegate(value: unknown): Uint8Array;
};

export const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
export const BUYER = "bob.testnet";
export const VAULT = "acme.nomos.euthyna.testnet";
export const requirement: PaymentRequirement = { scheme: "exact", network: "near:testnet", asset: USDC, amount: "2000000", payTo: VAULT, maxTimeoutSeconds: 2400 };
export const buyerKey = KeyPair.fromRandom("ed25519");

export type Overrides = {
  key?: KeyPair; signWith?: KeyPair; sender?: string; receiver?: string; method?: string;
  args?: Record<string, unknown>; deposit?: bigint; gas?: bigint; nonce?: bigint; maxBlockHeight?: bigint; extraAction?: boolean;
};

export async function cheque(o: Overrides = {}): Promise<string> {
  const key = o.key ?? buyerKey;
  const call = transactions.functionCall(o.method ?? "ft_transfer", o.args ?? { receiver_id: VAULT, amount: "2000000" }, o.gas ?? 30_000_000_000_000n, o.deposit ?? 1n);
  const delegateAction = t.buildDelegateAction({
    actions: o.extraAction ? [call, transactions.transfer(1n)] : [call],
    maxBlockHeight: o.maxBlockHeight ?? 10_000n,
    nonce: o.nonce ?? 101n,
    publicKey: key.getPublicKey(),
    receiverId: o.receiver ?? USDC,
    senderId: o.sender ?? BUYER,
  });
  const signer = o.signWith ?? key;
  const { signedDelegateAction } = await t.signDelegateAction({ delegateAction, signer: { sign: async (message: Uint8Array) => signer.sign(createHash("sha256").update(message).digest()).signature } });
  // As NEAR wallets do: the protocol checks the signature over sha256(NEP-461 prefix + delegate).
  return Buffer.from(t.encodeSignedDelegate(signedDelegateAction)).toString("base64");
}

