/**
 * Solana gas paid by Euthyna. A Solana fee is paid in SOL by the transaction's signer, here the
 * company wallet (a key held by NEAR MPC). So that a company only ever holds the tokens it pays
 * with (EURC, USDC), Euthyna's tank tops the wallet up with a little SOL when an agent is about to
 * send a transfer it could not pay for: the fee, and the rent of the recipient's token account.
 *
 * The tank's key is SOLANA_FEE_TANK_SECRET, or derived from the NEAR relayer key (no new secret to
 * hand over). Caps: per vault per day, and in total per day. In memory: a restart resets them.
 */
import { createHash } from "node:crypto";

import {
  base58Decode,
  latestBlockhash,
  solanaAddressOfSeed,
  solanaRpc,
  systemTransferWire,
  base58Encode,
  type SolanaRpc,
} from "@euthyna/sdk/solana";

export type SolanaFuelResult =
  | { status: "funded"; signature: string; lamports: string; address: string }
  | { status: "enough"; lamports: string; address: string }
  | { status: "off" | "no_wallet" | "capped" | "tank_empty"; address?: string };

export interface SolanaFuelOptions {
  seed: Uint8Array;
  rpc: SolanaRpc;
  readWallet: (vaultAccountId: string) => Promise<string | null>;
  /** Top up when the wallet holds less than this… */
  belowLamports: bigint;
  /** …to this. */
  toLamports: bigint;
  perVaultPerDay: number;
  totalPerDayLamports: bigint;
  now?: () => number;
}

/** The tank's seed: an explicit secret (base58, 32 or 64 bytes), else derived from the NEAR relayer key. */
export function solanaTankSeed(explicit: string | undefined, nearRelayerPrivateKey: string): Uint8Array {
  if (explicit) {
    const bytes = base58Decode(explicit.trim());
    if (bytes.length !== 32 && bytes.length !== 64) throw new Error("SOLANA_FEE_TANK_SECRET: expected 32 or 64 bytes (base58)");
    return bytes.slice(0, 32);
  }
  return createHash("sha256").update("euthyna-solana-fee-tank-v1").update(nearRelayerPrivateKey).digest();
}

export class SolanaFuel {
  private readonly day = new Map<string, { day: number; count: number }>();
  private spent = { day: -1, lamports: 0n };
  private readonly inflight = new Map<string, Promise<SolanaFuelResult>>();
  readonly address: string;

  constructor(private readonly options: SolanaFuelOptions) {
    this.address = solanaAddressOfSeed(options.seed);
  }

  static fromRpcUrl(url: string, options: Omit<SolanaFuelOptions, "rpc">): SolanaFuel {
    return new SolanaFuel({ ...options, rpc: solanaRpc(url) });
  }

  async tank(): Promise<{ address: string; lamports: string }> {
    const balance = await this.options.rpc<{ value: number }>("getBalance", [this.address, { commitment: "confirmed" }]);
    return { address: this.address, lamports: String(balance.value) };
  }

  /** Tops the vault's Solana wallet up, when it holds less than `belowLamports`. One at a time per vault. */
  fuel(vaultAccountId: string): Promise<SolanaFuelResult> {
    const running = this.inflight.get(vaultAccountId);
    if (running) return running;
    const next = this.topUp(vaultAccountId).finally(() => this.inflight.delete(vaultAccountId));
    this.inflight.set(vaultAccountId, next);
    return next;
  }

  private async topUp(vaultAccountId: string): Promise<SolanaFuelResult> {
    if (this.options.toLamports <= 0n) return { status: "off" };
    const wallet = await this.options.readWallet(vaultAccountId);
    if (!wallet) return { status: "no_wallet" };
    const balance = BigInt((await this.options.rpc<{ value: number }>("getBalance", [wallet, { commitment: "confirmed" }])).value);
    if (balance >= this.options.belowLamports) return { status: "enough", lamports: String(balance), address: wallet };

    const today = Math.floor((this.options.now?.() ?? Date.now()) / 86_400_000);
    const used = this.day.get(vaultAccountId);
    const count = used?.day === today ? used.count : 0;
    if (this.spent.day !== today) this.spent = { day: today, lamports: 0n };
    const amount = this.options.toLamports - balance;
    if (count >= this.options.perVaultPerDay || this.spent.lamports + amount > this.options.totalPerDayLamports) {
      return { status: "capped", address: wallet };
    }
    const tank = BigInt((await this.options.rpc<{ value: number }>("getBalance", [this.address, { commitment: "confirmed" }])).value);
    // The tank keeps its own fee and rent-exempt minimum.
    if (tank < amount + 900_000n) return { status: "tank_empty", address: wallet };

    this.day.set(vaultAccountId, { day: today, count: count + 1 });
    this.spent.lamports += amount;
    const wire = systemTransferWire(this.options.seed, wallet, amount, await latestBlockhash(this.options.rpc));
    const signature = await this.options.rpc<string>("sendTransaction", [
      Buffer.from(wire).toString("base64"),
      { encoding: "base64", preflightCommitment: "confirmed" },
    ]);
    return { status: "funded", signature, lamports: String(amount), address: wallet };
  }
}

/** The vault's Solana wallet address (base58), or null when it has none. */
export async function solanaWalletOf(
  view: (accountId: string, method: string, args: Record<string, unknown>) => Promise<unknown>,
  vaultAccountId: string,
): Promise<string | null> {
  const wallet = await view(vaultAccountId, "get_solana_wallet", {}).catch(() => null) as { address: number[] | null } | null;
  return wallet?.address ? base58Encode(wallet.address) : null;
}
