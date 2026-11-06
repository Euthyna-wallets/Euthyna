/**
 * Sealed orders: the parts every client shares with `contracts/sealed-orders` and
 * `circuits/sealed-order`. The Poseidon2 commitment and the proof need bb.js and the circuit, so
 * they live where those are (apps/api for the watcher, the console for sealing); this file holds
 * what must match the contract byte for byte: the vault tag, the rate scale, the minimum output and
 * the swap calldata.
 */
import { bytesToHex, encodeAbiParameters, getAddress, hexToBytes, sha256, stringToBytes, type Hex } from "viem";

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
// DAO proposals (Sputnik FunctionCall kinds) for the sealed-orders contract
// ---------------------------------------------------------------------------

/** The vault role contracts/sealed-orders is a member of. */
export const SEALED_ROLE = "sealed-orders";
/** Storage for a config or an order, attached by the DAO (contracts/sealed-orders STORAGE_DEPOSIT). */
export const SEALED_DEPOSIT_YOCTO = "10000000000000000000000";

function jsonBase64(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function jsonFromBase64(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0))));
}
const call = (receiverId: string, method: string, args: unknown, deposit: string, gas: string) => ({
  FunctionCall: { receiver_id: receiverId, actions: [{ method_name: method, args: jsonBase64(args), deposit, gas }] },
});

export function sealedConfigureKind(sealedId: string, input: { vault: string; chainId: number; router: Hex; slippageBps: number }) {
  if (input.slippageBps < 0 || input.slippageBps > MAX_SLIPPAGE_BPS) throw new Error(`slippage: 0 to ${MAX_SLIPPAGE_BPS} basis points`);
  return call(sealedId, "configure", { vault: input.vault, role: SEALED_ROLE, chain_id: input.chainId, router: getAddress(input.router), slippage_bps: input.slippageBps }, SEALED_DEPOSIT_YOCTO, "60000000000000");
}

export function sealedSealKind(sealedId: string, commitment: Hex) {
  if (!/^0x[0-9a-f]{64}$/i.test(commitment) || parseInt(commitment.slice(2, 4), 16) >= 0x30) throw new Error("the commitment is not a field element");
  return call(sealedId, "seal", { commitment: commitment.toLowerCase() }, SEALED_DEPOSIT_YOCTO, "15000000000000");
}

export function sealedCancelKind(sealedId: string, id: number) {
  if (!Number.isInteger(id) || id < 0) throw new Error("order id");
  return call(sealedId, "cancel", { id }, "0", "15000000000000");
}

/** Describes a sealed-orders proposal for the vote page; null for anything else. */
export function describeSealedProposal(kind: unknown, sealedId: string | null): { title: string; details: string[] } | null {
  const fn = (kind as { FunctionCall?: { receiver_id?: string; actions?: Array<{ method_name: string; args: string }> } })?.FunctionCall;
  if (!sealedId || fn?.receiver_id !== sealedId || !fn.actions?.length) return null;
  const action = fn.actions[0]!;
  const args = jsonFromBase64(action.args) as Record<string, unknown>;
  if (action.method_name === "configure") {
    return { title: "Turn on sealed orders", details: [`vault ${String(args.vault)}, role ${String(args.role)}`, `router ${String(args.router)}, at most ${Number(args.slippage_bps) / 100}% under the proven rate`] };
  }
  if (action.method_name === "seal") {
    return { title: "Seal an order", details: [`commitment ${String(args.commitment)}`, "Pair, limit, size and deadline stay hidden: only members holding the order file know them."] };
  }
  if (action.method_name === "cancel") return { title: `Cancel sealed order #${String(args.id)}`, details: [] };
  return null;
}
