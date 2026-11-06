/**
 * Sealed orders: the parts every client shares with `contracts/sealed-orders` and
 * `circuits/sealed-order`. The Poseidon2 commitment and the proof need bb.js and the circuit, so
 * they live where those are (apps/api for the watcher, the console for sealing); this file holds
 * what must match the contract byte for byte: the vault tag, the rate scale, the minimum output and
 * the swap calldata.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, concatBytes, encodeAbiParameters, getAddress, hexToBytes, sha256, stringToBytes, type Hex } from "viem";

/** Rates are the output per unit of input (raw units), scaled by 1e18. */
export const RATE_SCALE = 10n ** 18n;
/** Uniswap SwapRouter02 `exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))`. */
export const EXACT_INPUT_SINGLE: Hex = "0x04e45aaf";
export const MAX_SLIPPAGE_BPS = 500;
/** A proof states when it was made; the contract takes it for 10 minutes. */
export const MAX_PROOF_AGE_S = 600;

/** Base Sepolia: Uniswap v3 SwapRouter02, QuoterV2, USDC (Circle) and WETH. */
export const BASE_SEPOLIA_UNISWAP = {
  chainId: 84532,
  router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" as Hex,
  quoter: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27" as Hex,
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex,
  weth: "0x4200000000000000000000000000000000000006" as Hex,
} as const;

/** The hidden terms and the public pair. Only `commitment` (computed from all of it) goes on chain. */
export type SealedOrder = {
  vaultId: string;
  chainId: number;
  tokenIn: Hex;
  tokenOut: Hex;
  fee: number;
  /** Worst accepted rate (out per in, raw units, ×1e18). */
  limitRate: bigint;
  /** Most `tokenIn` the order may sell in all its fills. */
  cap: bigint;
  /** Unix seconds after which it does not fill. */
  expiry: number;
  /** A random field element: without it nobody can test guesses against the commitment. */
  salt: bigint;
};

/** sha256 of the vault account with its first byte cleared: the contract's `vault_tag`. */
export function vaultTag(vaultId: string): bigint {
  const digest = hexToBytes(sha256(stringToBytes(vaultId)));
  digest[0] = 0;
  return BigInt(bytesToHex(digest));
}

/** The fields the commitment hashes, in the circuit's order. */
export function commitmentInputs(order: SealedOrder): bigint[] {
  return [
    vaultTag(order.vaultId),
    BigInt(order.chainId),
    BigInt(order.tokenIn),
    BigInt(order.tokenOut),
    BigInt(order.fee),
    order.limitRate,
    order.cap,
    BigInt(order.expiry),
    order.salt,
  ];
}

/** What the swap must at least return: amount × rate / 1e18, less the slippage. Same as the contract. */
export function minOut(amountIn: bigint, rate: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) throw new Error("slippage out of range");
  return (((amountIn * rate) / RATE_SCALE) * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** The rate a quote gives: `amountOut` for `amountIn`, ×1e18 (rounded down, so never better than quoted). */
export function rateOf(amountIn: bigint, amountOut: bigint): bigint {
  if (amountIn <= 0n) throw new Error("amountIn must be positive");
  return (amountOut * RATE_SCALE) / amountIn;
}

/** A human price ("2500 USDC per WETH" for a USDC→WETH order) as a rate in raw units. */
export function rateFromPrice(pricePerOut: number, decimalsIn: number, decimalsOut: number): bigint {
  if (!(pricePerOut > 0)) throw new Error("price must be positive");
  // out per in = 1 / price, in raw units: 10^decimalsOut / (price × 10^decimalsIn), ×1e18.
  const priceMicro = BigInt(Math.round(pricePerOut * 1e6));
  return (10n ** BigInt(decimalsOut) * RATE_SCALE * 1_000_000n) / (priceMicro * 10n ** BigInt(decimalsIn));
}

/** The calldata `fill` asks the vault to sign: SwapRouter02 exactInputSingle, sqrtPriceLimit 0. */
export function exactInputSingleCalldata(args: {
  tokenIn: Hex;
  tokenOut: Hex;
  fee: number;
  recipient: Hex;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): Hex {
  const encoded = encodeAbiParameters(
    [{ type: "tuple", components: [
      { type: "address" }, { type: "address" }, { type: "uint24" }, { type: "address" },
      { type: "uint256" }, { type: "uint256" }, { type: "uint160" },
    ] }],
    [[getAddress(args.tokenIn), getAddress(args.tokenOut), args.fee, getAddress(args.recipient), args.amountIn, args.amountOutMinimum, 0n]],
  );
  return `${EXACT_INPUT_SINGLE}${encoded.slice(2)}` as Hex;
}

/** A random salt below the BN254 modulus (31 random bytes). */
export function randomSalt(): bigint {
  const bytes = new Uint8Array(31);
  globalThis.crypto.getRandomValues(bytes);
  return BigInt(bytesToHex(bytes));
}

/** The order as a member keeps it (a file, or the watcher's store): bigints as strings. */
export function serializeOrder(order: SealedOrder): Record<string, string | number> {
  return { ...order, limitRate: order.limitRate.toString(), cap: order.cap.toString(), salt: `0x${order.salt.toString(16)}` };
}

export function parseOrder(value: Record<string, unknown>): SealedOrder {
  const text = (key: string) => {
    const field = value[key];
    if (typeof field !== "string" && typeof field !== "number") throw new Error(`order: ${key} missing`);
    return String(field);
  };
  return {
    vaultId: text("vaultId"),
    chainId: Number(text("chainId")),
    tokenIn: getAddress(text("tokenIn")),
    tokenOut: getAddress(text("tokenOut")),
    fee: Number(text("fee")),
    limitRate: BigInt(text("limitRate")),
    cap: BigInt(text("cap")),
    expiry: Number(text("expiry")),
    salt: BigInt(text("salt")),
  };
}

// ---------------------------------------------------------------------------
// Calls and DAO proposals for contracts/sealed-orders (v2)
// ---------------------------------------------------------------------------

/** Storage for an order or a reader key (contracts/sealed-orders STORAGE_DEPOSIT, 0.02 NEAR). */
export const SEALED_DEPOSIT_YOCTO = "20000000000000000000000";
const SEAL_GAS = "100000000000000";
const APPROVE_GAS = "300000000000000";
const CANCEL_GAS = "50000000000000";

function jsonBase64(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function jsonFromBase64(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0))));
}

export type SealArgs = { vault: string; role: string; chainId: number; commitment: Hex; slippageBps: number; terms?: string | null };
export type ApproveArgs = { vault: string; role: string; chainId: number; token: Hex; router: Hex; amount: bigint; gasLimit?: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas?: bigint };

export function sealArgs(input: SealArgs) {
  if (!/^0x[0-9a-f]{64}$/i.test(input.commitment) || parseInt(input.commitment.slice(2, 4), 16) >= 0x30) throw new Error("the commitment is not a field element");
  if (input.slippageBps < 0 || input.slippageBps > MAX_SLIPPAGE_BPS) throw new Error(`slippage: 0 to ${MAX_SLIPPAGE_BPS} basis points`);
  return { vault: input.vault, role: input.role, chain_id: input.chainId, commitment: input.commitment.toLowerCase(), slippage_bps: input.slippageBps, terms: input.terms ?? null };
}

export function approveArgs(input: ApproveArgs) {
  return {
    vault: input.vault, role: input.role, chain_id: input.chainId, token: getAddress(input.token), router: getAddress(input.router),
    amount: input.amount.toString(), gas_limit: (input.gasLimit ?? 80_000n).toString(),
    max_fee_per_gas: input.maxFeePerGas.toString(), max_priority_fee_per_gas: (input.maxPriorityFeePerGas ?? 1_000_000n).toString(),
  };
}

type Action = { method_name: string; args: string; deposit: string; gas: string };
const action = (method: string, args: unknown, deposit: string, gas: string): Action => ({ method_name: method, args: jsonBase64(args), deposit, gas });

/** The DAO's order: one proposal, the router approval first when the wallet needs one, then the seal. */
export function sealedOrderKind(sealedId: string, seal: SealArgs, approve?: ApproveArgs) {
  const actions = [
    ...(approve ? [action("approve", approveArgs(approve), "0", APPROVE_GAS)] : []),
    action("seal", sealArgs(seal), SEALED_DEPOSIT_YOCTO, SEAL_GAS),
  ];
  return { FunctionCall: { receiver_id: sealedId, actions } };
}

export function sealedCancelKind(sealedId: string, vault: string, id: number) {
  if (!Number.isInteger(id) || id < 0) throw new Error("order id");
  return { FunctionCall: { receiver_id: sealedId, actions: [action("cancel", { vault, id }, "0", CANCEL_GAS)] } };
}

/** Describes a sealed-orders proposal for the vote page; null for anything else. */
export function describeSealedProposal(kind: unknown, sealedId: string | null): { title: string; details: string[] } | null {
  const fn = (kind as { FunctionCall?: { receiver_id?: string; actions?: Action[] } })?.FunctionCall;
  if (!sealedId || fn?.receiver_id !== sealedId || !fn.actions?.length) return null;
  const details: string[] = [];
  let title = "Sealed orders";
  for (const item of fn.actions) {
    const args = jsonFromBase64(item.args) as Record<string, unknown>;
    if (item.method_name === "seal") {
      title = "Seal an order";
      details.push(`hash ${String(args.commitment)}, filled through the role ${String(args.role)}`);
      details.push("Price limit, size and deadline stay hidden; members read them with their key.");
    } else if (item.method_name === "approve") {
      details.push(`Uniswap may take up to ${Number(args.amount) / 1e6} USDC from the wallet (within the role)`);
    } else if (item.method_name === "cancel") {
      title = `Cancel sealed order #${String(args.id)}`;
    }
  }
  return { title, details };
}

// ---------------------------------------------------------------------------
// Terms for the members: X25519 keys derived from a wallet signature
// ---------------------------------------------------------------------------

/** What a member signs (NEP-413) to derive their reading key; fixed, so the key is the same each time. */
export function readerMessage(vault: string) {
  return {
    message: `Read the sealed orders of ${vault} on Euthyna. This signature derives a reading key; it moves nothing.`,
    recipient: "euthyna.io",
    nonce: hexToBytes(sha256(stringToBytes(`euthyna-sealed-reader:${vault}`))),
  };
}

/** The member's X25519 key pair from their NEP-413 signature (ed25519 signatures are deterministic). */
export function readerKeyFromSignature(signature: Uint8Array) {
  const privateKey = hexToBytes(sha256(concatBytes([stringToBytes("euthyna-sealed-terms-v1"), signature])));
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
export const publicKeyBase64 = b64;

async function aes(key: Uint8Array, usage: "encrypt" | "decrypt") {
  return globalThis.crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [usage]);
}

type Envelope = { v: 1; epk: string; iv: string; ct: string; keys: Record<string, { iv: string; key: string }> };

/**
 * Encrypts the terms for each reader: one random content key (AES-256-GCM), wrapped for every
 * reader with a key from X25519(ephemeral, reader) hashed with both public keys.
 */
export async function encryptTerms(terms: SealedOrder, readers: Array<{ account: string; publicKey: string }>): Promise<string> {
  if (!readers.length) throw new Error("no member has registered a reading key yet");
  const random = (size: number) => globalThis.crypto.getRandomValues(new Uint8Array(size));
  const contentKey = random(32);
  const ephemeral = random(32);
  const epk = x25519.getPublicKey(ephemeral);
  const iv = random(12);
  const plaintext = new TextEncoder().encode(JSON.stringify(serializeOrder(terms)));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(contentKey, "encrypt"), plaintext));
  const keys: Envelope["keys"] = {};
  for (const reader of readers) {
    const readerKey = unb64(reader.publicKey);
    const kek = hexToBytes(sha256(concatBytes([x25519.getSharedSecret(ephemeral, readerKey), epk, readerKey])));
    const wrapIv = random(12);
    const wrapped = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv }, await aes(kek, "encrypt"), contentKey));
    keys[reader.account] = { iv: b64(wrapIv), key: b64(wrapped) };
  }
  const envelope: Envelope = { v: 1, epk: b64(epk), iv: b64(iv), ct: b64(ct), keys };
  return btoa(JSON.stringify(envelope));
}

/** The terms, for a reader holding their private key; null when the order was not encrypted to them. */
export async function decryptTerms(terms: string, account: string, privateKey: Uint8Array): Promise<SealedOrder | null> {
  const envelope = JSON.parse(atob(terms)) as Envelope;
  const mine = envelope.keys[account];
  if (envelope.v !== 1 || !mine) return null;
  const epk = unb64(envelope.epk);
  const kek = hexToBytes(sha256(concatBytes([x25519.getSharedSecret(privateKey, epk), epk, x25519.getPublicKey(privateKey)])));
  const contentKey = new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(mine.iv) }, await aes(kek, "decrypt"), unb64(mine.key)));
  const plaintext = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(envelope.iv) }, await aes(contentKey, "decrypt"), unb64(envelope.ct));
  return parseOrder(JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>);
}
