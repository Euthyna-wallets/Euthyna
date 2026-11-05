/**
 * Euthyna Market cheques, built in any JavaScript runtime (the browser included: no Node
 * built-ins, no Buffer). A cheque is an x402 v2 `X-PAYMENT` header carrying a NEP-366
 * SignedDelegate of exactly one `ft_transfer`, the form apps/api/src/market/cheque.ts verifies:
 * canonical args `{"receiver_id":"<payTo>","amount":"<amount>"}`, 1 yoctoNEAR, 10 to 30 Tgas,
 * a nonce above the key's, and a life of at least 2 blocks per second of `maxTimeoutSeconds`.
 *
 * The borsh is written by hand (a handful of fields); the key signs
 * sha256(NEP-461 prefix + delegate action), as NEAR wallets and the protocol do.
 * Used by Rob the Agent's « Hire him » (apps/console, throwaway key in the browser).
 */
import { sha256 } from "viem";

import { base58Decode } from "./solana.js";

/** What a seller asks for in its 402 (`accepts[0]`), echoed back in `accepted`. */
export type ChequeRequirement = { scheme: string; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number };

/** The gateway accepts 10 to 30 Tgas; ft_transfer and its refund fit well within 30. */
export const CHEQUE_GAS = 30_000_000_000_000n;
/** NEP-461: signed delegate actions are prefixed with 2^30 + 366 (u32, little endian). */
export const NEP366_PREFIX = 2 ** 30 + 366;
/** Blocks of margin beyond the gateway's minimum life (2 blocks per second of the timeout). */
export const CHEQUE_EXTRA_BLOCKS = 120n;

/** The only args the gateway accepts, byte for byte: receiver_id, then amount. */
export function chequeArgs(payTo: string, amount: string): string {
  return JSON.stringify({ receiver_id: payTo, amount });
}

class Borsh {
  private readonly out: number[] = [];
  u8(value: number) {
    this.out.push(value & 0xff);
  }
  u32(value: number) {
    for (let index = 0; index < 4; index += 1) this.out.push((value >>> (8 * index)) & 0xff);
  }
  uint(value: bigint, bytes: number) {
    if (value < 0n || value >= 1n << BigInt(8 * bytes)) throw new Error(`borsh: ${value} does not fit in ${bytes} bytes`);
    for (let index = 0; index < bytes; index += 1) this.out.push(Number((value >> BigInt(8 * index)) & 0xffn));
  }
  fixed(bytes: Uint8Array) {
    this.out.push(...bytes);
  }
  vec(bytes: Uint8Array) {
    this.u32(bytes.length);
    this.fixed(bytes);
  }
  string(text: string) {
    this.vec(new TextEncoder().encode(text));
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

/** "ed25519:<base58>" -> the 32 key bytes. */
export function ed25519KeyBytes(publicKey: string): Uint8Array {
  const match = /^ed25519:([1-9A-HJ-NP-Za-km-z]{43,44})$/.exec(publicKey);
  if (!match) throw new Error("only ed25519 keys (ed25519:<base58>) can sign a cheque");
  const bytes = base58Decode(match[1]!);
  if (bytes.length !== 32) throw new Error("an ed25519 public key is 32 bytes");
  return bytes;
}

export type DelegateInput = {
  senderId: string;
  /** The token contract. */
  receiverId: string;
  methodName: string;
  args: Uint8Array;
  gas: bigint;
  deposit: bigint;
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: Uint8Array;
};

/** Borsh of a DelegateAction holding one FunctionCall (nearcore's layout). */
export function encodeDelegateAction(input: DelegateInput): Uint8Array {
  const writer = new Borsh();
  writer.string(input.senderId);
  writer.string(input.receiverId);
  writer.u32(1); // one action
  writer.u8(2); // Action::FunctionCall
  writer.string(input.methodName);
  writer.vec(input.args);
  writer.uint(input.gas, 8);
  writer.uint(input.deposit, 16);
  writer.uint(input.nonce, 8);
  writer.uint(input.maxBlockHeight, 8);
  writer.u8(0); // ed25519
  writer.fixed(input.publicKey);
  return writer.bytes();
}

/** What the key signs: sha256(u32le(2^30 + 366) || borsh(delegate action)). */
export function delegateSigningHash(delegateBorsh: Uint8Array): Uint8Array {
  const prefixed = new Uint8Array(4 + delegateBorsh.length);
  new DataView(prefixed.buffer).setUint32(0, NEP366_PREFIX, true);
  prefixed.set(delegateBorsh, 4);
  return sha256(prefixed, "bytes");
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/**
 * Checks a 402 requirement before anything is signed: a seller's answer is untrusted.
 * Throws unless it is an exact x402 v2 payment with a whole amount and a sane timeout.
 */
export function assertRequirement(requirement: ChequeRequirement): void {
  if (requirement.scheme !== "exact") throw new Error("market: unsupported payment scheme");
  if (typeof requirement.amount !== "string" || !/^[1-9]\d{0,38}$/.test(requirement.amount)) throw new Error("market: the payment request has no valid amount");
  if (!Number.isInteger(requirement.maxTimeoutSeconds) || requirement.maxTimeoutSeconds < 1 || requirement.maxTimeoutSeconds > 90_000) {
    throw new Error("market: the payment request has no valid maxTimeoutSeconds");
  }
  if (typeof requirement.payTo !== "string" || typeof requirement.asset !== "string" || !requirement.payTo || !requirement.asset) throw new Error("market: unsupported payment request");
}

export type SignChequeInput = {
  requirement: ChequeRequirement;
  /** The paying account (a throwaway key's implicit account, a card...). */
  senderId: string;
  /** Its full-access key, ed25519:<base58>. Function-call keys cannot pay a NEP-141 token. */
  publicKey: string;
  /** The key's nonce on chain now; the cheque uses the next one. */
  accessKeyNonce: bigint | number | string;
  /** A recent final block height. */
  blockHeight: bigint | number | string;
  /** Signs the 32-byte hash with the key's secret (ed25519, 64-byte signature). */
  sign: (hash: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  gas?: bigint;
  extraBlocks?: bigint;
};

export type SignedCheque = {
  /** The X-PAYMENT header value: base64 JSON { x402Version: 2, accepted, payload: { signedDelegateAction } }. */
  header: string;
  /** base64 borsh SignedDelegate. */
  signedDelegateAction: string;
  nonce: bigint;
  maxBlockHeight: bigint;
};

/** One ft_transfer of `requirement.amount` to `requirement.payTo`, on `requirement.asset`, signed by the key. */
export async function signCheque(input: SignChequeInput): Promise<SignedCheque> {
  assertRequirement(input.requirement);
  const { requirement } = input;
  const nonce = BigInt(input.accessKeyNonce) + 1n;
  const maxBlockHeight = BigInt(input.blockHeight) + BigInt(requirement.maxTimeoutSeconds) * 2n + (input.extraBlocks ?? CHEQUE_EXTRA_BLOCKS);
  const publicKey = ed25519KeyBytes(input.publicKey);
  const delegate = encodeDelegateAction({
    senderId: input.senderId,
    receiverId: requirement.asset,
    methodName: "ft_transfer",
    args: new TextEncoder().encode(chequeArgs(requirement.payTo, requirement.amount)),
    gas: input.gas ?? CHEQUE_GAS,
    deposit: 1n,
    nonce,
    maxBlockHeight,
    publicKey,
  });
  const signature = await input.sign(delegateSigningHash(delegate));
  if (signature.length !== 64) throw new Error("an ed25519 signature is 64 bytes");
  const signed = new Uint8Array(delegate.length + 1 + 64);
  signed.set(delegate, 0);
  signed[delegate.length] = 0; // ed25519 signature
  signed.set(signature, delegate.length + 1);
  const signedDelegateAction = base64(signed);
  const header = base64(new TextEncoder().encode(JSON.stringify({ x402Version: 2, accepted: requirement, payload: { signedDelegateAction } })));
  return { header, signedDelegateAction, nonce, maxBlockHeight };
}
