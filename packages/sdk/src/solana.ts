/**
 * Solana for OmniRoles: the company wallet is an ed25519 key derived by NEAR MPC.
 * Roles allow SOL or SPL transfers to listed recipients within a budget; the
 * vault builds and signs the exact transaction (see contracts/vault/src/solana.rs).
 */

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
