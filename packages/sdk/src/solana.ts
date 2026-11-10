/**
 * Solana for OmniRoles: the company wallet is an ed25519 key derived by NEAR MPC.
 * Roles allow SOL or SPL transfers to listed recipients within a budget; the
 * vault builds and signs the exact transaction (see contracts/vault/src/solana.rs).
 */

import { ed25519 } from "@noble/curves/ed25519.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array | number[]): string {
  const input = Array.from(bytes);
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros += 1;
  let value = 0n;
  for (const byte of input) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function base58Decode(text: string): Uint8Array {
  let value = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error(`not base58: ${text}`);
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

/** A 32-byte Solana address, as the vault expects it. */
export function solanaAddress(text: string): number[] {
  const bytes = base58Decode(text.trim());
  if (bytes.length !== 32) throw new Error(`${text} is not a Solana address`);
  return Array.from(bytes);
}

export function isSolanaAddress(text: string): boolean {
  try {
    solanaAddress(text);
    return true;
  } catch {
    return false;
  }
}

export type SolanaToken = { symbol: string; decimals: number; mint: string | null };

export type SolanaProfile = { name: string; cluster: "devnet" | "mainnet-beta"; rpcUrl: string; explorer: string; tokens: SolanaToken[] };

export const SOLANA_DEVNET: SolanaProfile = {
  name: "Solana devnet",
  cluster: "devnet",
  rpcUrl: "https://api.devnet.solana.com",
  explorer: "https://explorer.solana.com/tx/{tx}?cluster=devnet",
  tokens: [
    { symbol: "SOL", decimals: 9, mint: null },
    // Circle's devnet USDC (faucet.circle.com).
    { symbol: "USDC", decimals: 6, mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
    // Noah's sandbox EURC (EURC_TEST): what a company's euro account pays out on Solana.
    { symbol: "EURC", decimals: 6, mint: "7D6hWbuzWmEJJmWQ7iVz3p6oxiXoQwfTCVnsqZZ4AhnF" },
  ],
};

/** Vault JSON for an asset: "Sol" or { Spl: { mint } }. */
export function solanaAsset(token: SolanaToken): "Sol" | { Spl: { mint: number[] } } {
  return token.mint ? { Spl: { mint: solanaAddress(token.mint) } } : "Sol";
}

export function solanaTokenOf(profile: SolanaProfile, mintOrSymbol: string | null): SolanaToken {
  const token = profile.tokens.find((item) => item.mint === mintOrSymbol || item.symbol === mintOrSymbol || (mintOrSymbol === null && item.mint === null));
  if (!token) throw new Error(`unknown Solana token ${mintOrSymbol ?? "SOL"} on ${profile.name}`);
  return token;
}

// ---------------------------------------------------------------------------
// Agent side: fresh blockhash, broadcast, finality (public RPC, no secret)
// ---------------------------------------------------------------------------

export type SolanaRpc = <T>(method: string, params: unknown[]) => Promise<T>;

export function solanaRpc(url: string): SolanaRpc {
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
    const body = (await response.json()) as { result: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
}

export async function latestBlockhash(rpc: SolanaRpc): Promise<number[]> {
  const result = await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "finalized" }]);
  return Array.from(base58Decode(result.value.blockhash));
}

/** Sends the vault-signed wire transaction; returns its signature (the tx id). */
export async function broadcast(rpc: SolanaRpc, wire: number[]): Promise<string> {
  const base64 = btoa(String.fromCharCode(...wire));
  return rpc<string>("sendTransaction", [base64, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" }]);
}

/** One signature's fee. */
export const SOLANA_FEE_LAMPORTS = 5_000n;
/** A system account left with less than this (and more than zero) makes the transfer fail. */
export const SOLANA_RENT_EXEMPT_LAMPORTS = 890_880n;
/** Creating the recipient's token account, which the wallet pays when it does not exist yet. */
export const SOLANA_TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

/**
 * Why the wallet cannot pay this transfer, or null. Checked before the vault signs: a transfer
 * signed but never landed keeps the role's budget, and the role itself, reserved until it can be
 * declared unconfirmed (hours later).
 */
export function solanaShortfall(input: { lamports: bigint; tokenBalance: bigint | null }, token: SolanaToken, amount: bigint): string | null {
  if (token.mint === null) {
    const left = input.lamports - amount - SOLANA_FEE_LAMPORTS;
    if (left < 0n || (left > 0n && left < SOLANA_RENT_EXEMPT_LAMPORTS)) {
      return `the wallet holds ${input.lamports} lamports: it needs the amount, ${SOLANA_FEE_LAMPORTS} for the fee, and to keep at least ${SOLANA_RENT_EXEMPT_LAMPORTS} (or nothing)`;
    }
    return null;
  }
  if ((input.tokenBalance ?? 0n) < amount) return `the wallet holds ${input.tokenBalance ?? 0n} of this token, under ${amount}`;
  if (input.lamports < SOLANA_FEE_LAMPORTS + SOLANA_TOKEN_ACCOUNT_RENT_LAMPORTS) {
    return `the wallet holds ${input.lamports} lamports: it needs ${SOLANA_FEE_LAMPORTS + SOLANA_TOKEN_ACCOUNT_RENT_LAMPORTS} for the fee and, if needed, the recipient's token account`;
  }
  return null;
}

/** What the wallet holds: SOL, and the token when there is one. */
export async function solanaHoldings(rpc: SolanaRpc, owner: string, token: SolanaToken): Promise<{ lamports: bigint; tokenBalance: bigint | null }> {
  const balance = await rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
  if (!token.mint) return { lamports: BigInt(balance.value), tokenBalance: null };
  const accounts = await rpc<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }> }>(
    "getTokenAccountsByOwner",
    [owner, { mint: token.mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
  );
  const tokenBalance = accounts.value.reduce((sum, item) => sum + BigInt(item.account.data.parsed.info.tokenAmount.amount), 0n);
  return { lamports: BigInt(balance.value), tokenBalance };
}

export type SolanaStatus = { finalized: boolean; failed: boolean; err: unknown };

export async function signatureStatus(rpc: SolanaRpc, signature: string): Promise<SolanaStatus | null> {
  const result = await rpc<{ value: Array<{ confirmationStatus: string | null; err: unknown } | null> }>(
    "getSignatureStatuses",
    [[signature], { searchTransactionHistory: true }],
  );
  const status = result.value[0];
  if (!status) return null;
  return { finalized: status.confirmationStatus === "finalized", failed: status.err !== null, err: status.err };
}

// ---------------------------------------------------------------------------
// Euthyna's SOL tank: tops up a company wallet so it never has to buy SOL
// ---------------------------------------------------------------------------

/** The tank's address from its 32-byte ed25519 seed. */
export function solanaAddressOfSeed(seed: Uint8Array): string {
  return base58Encode(ed25519.getPublicKey(seed));
}

/** A signed SystemProgram transfer from the seed's key (legacy message, one signature), as wire bytes. */
export function systemTransferWire(seed: Uint8Array, to: string, lamports: bigint, blockhash: number[]): number[] {
  const from = ed25519.getPublicKey(seed);
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  // Header: 1 signature, 0 read-only signed, 1 read-only unsigned (the system program).
  const message = [
    1, 0, 1,
    3, ...from, ...solanaAddress(to), ...new Array<number>(32).fill(0),
    ...blockhash,
    1, 2, 2, 0, 1, data.length, ...data,
  ];
  const signature = ed25519.sign(Uint8Array.from(message), seed);
  return [1, ...signature, ...message];
}
