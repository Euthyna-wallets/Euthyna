/**
 * Market payment cheques: an x402 v2 `X-PAYMENT` header carrying a NEP-366
 * signed delegate action that calls `ft_transfer` on the asset, from the buyer
 * to the seller's vault. The gateway holds it while the seller works and
 * relays it on delivery. Nothing here moves funds: it only decides whether a
 * cheque is good enough to start the work.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { transactions, utils } from "near-api-js";

// The delegate classes and borsh schema live in near-api-js's own transactions package.
const nearRequire = createRequire(createRequire(import.meta.url).resolve("near-api-js"));
const nearTransactions = nearRequire("@near-js/transactions") as {
  SCHEMA: { SignedDelegate: unknown };
  SignedDelegate: new (input: unknown) => unknown;
  encodeDelegateAction(delegateAction: unknown): Uint8Array;
};

export const X402_VERSION = 2;
/** The relayer pays the cheque's gas: at most 30 Tgas, and at least enough for ft_transfer to finish. */
export const MAX_CHEQUE_GAS = 30_000_000_000_000n;
export const MIN_CHEQUE_GAS = 10_000_000_000_000n;
/** NEAR testnet makes ~1.7 blocks per second (0.6 s, measured): count 2 per second of lifetime. */
export const BLOCKS_PER_SECOND = 2n;
const MEMO = /^[\x20-\x7e]{0,120}$/;
export const ONE_YOCTO = 1n;

/** What the seller asks for, as sent in the 402 and expected back in `accepted`. */
export type PaymentRequirement = {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
};

export type PaymentPayload = {
  x402Version: number;
  accepted: PaymentRequirement;
  payload: { signedDelegateAction: string };
};

export type DecodedCheque = {
  senderId: string;
  receiverId: string;
  publicKey: string;
  nonce: bigint;
  maxBlockHeight: bigint;
  methodName: string;
  args: unknown;
  /** The args exactly as signed (utf-8), for the canonical-form check. */
  argsText: string | null;
  gas: bigint;
  deposit: bigint;
  actionCount: number;
  /** sha256 of the signed message (NEP-461 prefix + delegate action): the replay key. */
  delegateHash: string;
  signatureValid: boolean;
  signedDelegateB64: string;
};

/** Chain reads the verification needs; injected so it can be tested. */
export interface ChequeChain {
  accessKey(accountId: string, publicKey: string): Promise<{ nonce: bigint; permission: "FullAccess" | { FunctionCall: { receiver_id: string; method_names: string[] } } } | null>;
  blockHeight(): Promise<bigint>;
  ftBalance(token: string, accountId: string): Promise<bigint>;
}

export class ChequeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type BorshDelegate = {
  delegateAction: {
    senderId: string;
    receiverId: string;
    actions: Array<Record<string, { methodName?: string; args?: Uint8Array | number[]; gas?: bigint; deposit?: bigint }>>;
    nonce: bigint;
    maxBlockHeight: bigint;
    publicKey: { ed25519Key?: { data: Uint8Array | number[] } };
  };
  signature: { ed25519Signature?: { data: Uint8Array | number[] } };
};

/** Base64 JSON header -> payload. Malformed input is a ChequeError, never a crash. */
export function parsePaymentHeader(header: string): PaymentPayload {
  if (header.length > 16_384) throw new ChequeError("payment_too_large", "x-payment header is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new ChequeError("payment_malformed", "x-payment is not base64 JSON");
  }
  const value = parsed as Partial<PaymentPayload> | null;
  if (!value || typeof value !== "object" || value.x402Version !== X402_VERSION) {
    throw new ChequeError("payment_version", `x402Version must be ${X402_VERSION}`);
  }
  if (!value.accepted || typeof value.accepted !== "object") throw new ChequeError("payment_malformed", "accepted is missing");
  if (typeof value.payload?.signedDelegateAction !== "string") throw new ChequeError("payment_malformed", "payload.signedDelegateAction is missing");
  return value as PaymentPayload;
}

export function decodeCheque(signedDelegateB64: string): DecodedCheque {
  let decoded: BorshDelegate;
  try {
    decoded = utils.serialize.deserialize(nearTransactions.SCHEMA.SignedDelegate as never, Buffer.from(signedDelegateB64, "base64")) as BorshDelegate;
  } catch {
    throw new ChequeError("delegate_malformed", "signedDelegateAction is not a borsh SignedDelegate");
  }
  const action = decoded.delegateAction;
  const keyBytes = action.publicKey.ed25519Key?.data;
  const signatureBytes = decoded.signature.ed25519Signature?.data;
  if (!keyBytes || !signatureBytes) throw new ChequeError("delegate_key_type", "only ed25519 keys are accepted");
  const publicKey = new utils.PublicKey({ keyType: 0, data: Uint8Array.from(keyBytes) });
  // The signed message: sha256 of the NEP-461-prefixed delegate action, as wallets sign it.
  const message = createHash("sha256").update(nearTransactions.encodeDelegateAction(action)).digest();
  const signatureValid = publicKey.verify(message, Uint8Array.from(signatureBytes));
  const first = action.actions[0] ?? {};
  const functionCall = first.functionCall;
  let args: unknown = null;
  const argsText = functionCall?.args ? Buffer.from(Uint8Array.from(functionCall.args)).toString("utf8") : null;
  if (argsText !== null) {
    try {
      args = JSON.parse(argsText);
    } catch {
      args = null;
    }
  }
  return {
    senderId: action.senderId,
    receiverId: action.receiverId,
    publicKey: publicKey.toString(),
    nonce: BigInt(action.nonce),
    maxBlockHeight: BigInt(action.maxBlockHeight),
    methodName: functionCall?.methodName ?? Object.keys(first)[0] ?? "",
    args,
    argsText,
    gas: BigInt(functionCall?.gas ?? 0n),
    deposit: BigInt(functionCall?.deposit ?? 0n),
    actionCount: action.actions.length,
    delegateHash: message.toString("hex"),
    signatureValid,
    signedDelegateB64,
  };
}

const sameRequirement = (a: PaymentRequirement, b: PaymentRequirement) =>
  a.scheme === b.scheme && a.network === b.network && a.asset === b.asset && a.amount === b.amount && a.payTo === b.payTo && a.maxTimeoutSeconds === b.maxTimeoutSeconds;

/**
 * The seven checks, in order; the first failure is the answer.
 * `seen` says whether this delegate hash was already used (replay).
 */
export async function verifyCheque(
  payment: PaymentPayload,
  requirement: PaymentRequirement,
  chain: ChequeChain,
  seen: (delegateHash: string) => Promise<boolean>,
): Promise<DecodedCheque> {
  // 1. Decodes.
  const cheque = decodeCheque(payment.payload.signedDelegateAction);
  // 2. Pays for what we asked.
  if (!sameRequirement(payment.accepted, requirement)) throw new ChequeError("requirement_mismatch", "accepted does not match the payment requirements of this listing");
  // 3. Exactly one ft_transfer of the exact amount to the seller, on the asset, with 1 yocto.
  if (cheque.receiverId !== requirement.asset) throw new ChequeError("wrong_asset", `the delegate must call ${requirement.asset}`);
  if (cheque.actionCount !== 1) throw new ChequeError("wrong_actions", "the delegate must hold exactly one action");
  if (cheque.methodName !== "ft_transfer") throw new ChequeError("wrong_method", "the only action must be ft_transfer");
  // The args must be exactly the canonical JSON we would write: anything the
  // token could parse differently (duplicate keys, odd escapes, bad utf-8)
  // could fail on chain after the work is done.
  const args = cheque.args as Record<string, unknown> | null;
  const memo = args && typeof args.memo === "string" && MEMO.test(args.memo) ? args.memo : undefined;
  const canonical = [
    JSON.stringify({ receiver_id: requirement.payTo, amount: requirement.amount }),
    ...(memo === undefined ? [] : [JSON.stringify({ receiver_id: requirement.payTo, amount: requirement.amount, memo })]),
  ];
  if (cheque.argsText === null || !canonical.includes(cheque.argsText)) {
    throw new ChequeError("wrong_transfer", `ft_transfer args must be exactly {"receiver_id":"${requirement.payTo}","amount":"${requirement.amount}"} (optional "memo": printable ASCII, 120 chars)`);
  }
  if (cheque.deposit !== ONE_YOCTO) throw new ChequeError("wrong_deposit", "ft_transfer must attach exactly 1 yoctoNEAR");
  if (cheque.gas > MAX_CHEQUE_GAS) throw new ChequeError("too_much_gas", "the delegate may ask for at most 30 Tgas");
  if (cheque.gas < MIN_CHEQUE_GAS) throw new ChequeError("too_little_gas", "the delegate must give ft_transfer at least 10 Tgas");
  // 4. Signed by a key of the sender. Function-call keys cannot attach the 1 yocto
  //    ft_transfer needs (DelegateActionAccessKeyError::DepositWithFunctionCall).
  if (!cheque.signatureValid) throw new ChequeError("bad_signature", "the delegate signature does not match its public key");
  const key = await chain.accessKey(cheque.senderId, cheque.publicKey);
  if (!key) throw new ChequeError("unknown_key", `${cheque.publicKey} is not a key of ${cheque.senderId}`);
  if (key.permission !== "FullAccess") throw new ChequeError("function_call_key", "function-call keys cannot pay a NEP-141 token: sign with a full-access key");
  // 5. Not yet used on chain, and alive long enough for the work.
  if (cheque.nonce <= key.nonce) throw new ChequeError("stale_nonce", "the delegate nonce is already used on chain");
  const height = await chain.blockHeight();
  const minHeight = height + BigInt(requirement.maxTimeoutSeconds) * BLOCKS_PER_SECOND;
  if (cheque.maxBlockHeight < minHeight) throw new ChequeError("expires_too_soon", `maxBlockHeight must be at least ${minHeight} (current height + 2 x maxTimeoutSeconds)`);
  // 6. Never seen by us.
  if (await seen(cheque.delegateHash)) throw new ChequeError("replayed", "this cheque was already used");
  // 7. Covered today.
  const balance = await chain.ftBalance(requirement.asset, cheque.senderId);
  if (balance < BigInt(requirement.amount)) throw new ChequeError("insufficient_balance", `${cheque.senderId} holds less than ${requirement.amount}`);
  return cheque;
}

/** Rebuilds the near-api-js action that relays a held cheque. */
export function relayAction(signedDelegateB64: string): InstanceType<typeof transactions.Action> {
  const decoded = utils.serialize.deserialize(nearTransactions.SCHEMA.SignedDelegate as never, Buffer.from(signedDelegateB64, "base64"));
  return new transactions.Action({ signedDelegate: new nearTransactions.SignedDelegate(decoded) } as never);
}
