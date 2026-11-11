/**
 * The worker's follow-up of Solana transfers, so that nothing waits on the agent staying online:
 *
 * - landed and finalized → `settle_solana` (MPC attests it on chain; the vault trusts nothing else);
 * - not landed yet, while its blockhash may still be valid → broadcast again (the agent may be gone);
 * - not landed after `SOLANA_EXPIRED_AFTER_MS` → `release_solana_unconfirmed` (the role is freed;
 *   vaults before that version take their settlement timeout: retried then).
 *
 * The RPC only says when to act; every decision is the vault's. Operations come from the vault's own
 * logs (the transaction index), read when a notice concerns the vault and once an hour otherwise.
 */
import { base58Encode, type SolanaRpc } from "@euthyna/sdk/solana";

import { vaultLogs } from "./chain-activity.js";

export const SOLANA_EXPIRED_AFTER_MS = 15 * 60_000;
/** A transaction's blockhash lasts 150 blocks: it is sent again only within this window. */
const REBROADCAST_WITHIN_MS = 90_000;
const FOLLOW_EVERY_MS = 10_000;

type SolanaOperationView = {
  state: string;
  signature: number[] | null;
  signed_transaction: number[] | null;
  signed_at_ns: string;
};

export interface SolanaFollowerNear {
  viewFunction<T>(accountId: string, methodName: string, args?: Record<string, unknown>): Promise<T>;
  callFunction(contractId: string, methodName: string, args: Record<string, unknown>, gas: string, depositYocto: string): Promise<string>;
}

type Followed = { vault: string; opId: string; next: number; releaseAt?: number; settling?: number };

export class SolanaFollower {
  private readonly followed = new Map<string, Followed>();
  private readonly scanned = new Map<string, number>();

  constructor(
    private readonly near: SolanaFollowerNear,
    private readonly rpc: SolanaRpc,
    private readonly indexerUrl: string,
    private readonly log: (event: string, fields: Record<string, unknown>) => void = (event, fields) => console.log(JSON.stringify({ event, ...fields })),
    private readonly now: () => number = () => Date.now(),
    private readonly logsOf: (vault: string) => Promise<Array<{ kind: string; opId: string }>> = (vault) => vaultLogs(indexerUrl, vault),
  ) {}

  get size(): number {
    return this.followed.size;
  }

  /** Reads the vault's Solana operations (a notice, or the hourly sweep) and follows the open ones. */
  async scan(vault: string): Promise<void> {
    const last = this.scanned.get(vault) ?? 0;
    if (this.now() - last < 5_000) return;
    this.scanned.set(vault, this.now());
    const logs = await this.logsOf(vault);
    for (const log of logs) {
      if (log.kind !== "solana" || this.followed.has(log.opId)) continue;
      const view = await this.view(vault, log.opId);
      if (view?.state === "PossiblySigned") this.followed.set(log.opId, { vault, opId: log.opId, next: 0 });
    }
  }

  /** One pass over the operations due now. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const item of [...this.followed.values()]) {
      if (item.next > now) continue;
      await this.step(item).catch((error: unknown) => {
        item.next = now + 60_000;
        this.log("worker.solana_failed", { vault: item.vault, opId: item.opId, message: String(error).slice(0, 200) });
      });
    }
  }

  private async view(vault: string, opId: string): Promise<SolanaOperationView | null> {
    return await this.near.viewFunction<SolanaOperationView | null>(vault, "get_solana_operation", { op_id: Array.from(Buffer.from(opId.slice(2), "hex")) }).catch(() => null);
  }

  private async step(item: Followed): Promise<void> {
    const now = this.now();
    const op = await this.view(item.vault, item.opId);
    if (!op || op.state !== "PossiblySigned") {
      this.followed.delete(item.opId);
      if (op) this.log("worker.solana_done", { vault: item.vault, opId: item.opId, state: op.state });
      return;
    }
    const signedAt = Number(BigInt(op.signed_at_ns) / 1_000_000n);
    const age = now - signedAt;
    const opArgs = { op_id: Array.from(Buffer.from(item.opId.slice(2), "hex")) };
    const release = async () => {
      if (item.releaseAt && now < item.releaseAt) return void (item.next = item.releaseAt);
      try {
        await this.near.callFunction(item.vault, "release_solana_unconfirmed", opArgs, "30000000000000", "0");
        this.log("worker.solana_released", { vault: item.vault, opId: item.opId, ageMinutes: Math.round(age / 60_000) });
        item.next = now + FOLLOW_EVERY_MS;
      } catch (error) {
        if (!/ERR_UNCONFIRMED_TOO_EARLY/.test(String(error))) throw error;
        // A vault from before the Solana expiry: its settlement timeout.
        const config = await this.near.viewFunction<{ unconfirmed_after_ns: string }>(item.vault, "get_settlement_config").catch(() => null);
        const timeout = config ? Number(BigInt(config.unconfirmed_after_ns) / 1_000_000n) : 6 * 3_600_000;
        item.releaseAt = signedAt + timeout + 5_000;
        item.next = item.releaseAt;
      }
    };
    if (!op.signature || !op.signed_transaction) {
      // MPC never signed: nothing can land; freed like any lost transfer.
      if (age >= SOLANA_EXPIRED_AFTER_MS) return await release();
      return void (item.next = now + FOLLOW_EVERY_MS);
    }
    const signature = base58Encode(op.signature);
    const statuses = await this.rpc<{ value: Array<{ confirmationStatus?: string; err: unknown } | null> }>(
      "getSignatureStatuses", [[signature], { searchTransactionHistory: true }],
    );
    const status = statuses.value[0];
    if (status?.confirmationStatus === "finalized" && status.err === null) {
      // MPC attests it: one request at a time, a minute apart.
      if (item.settling && now - item.settling < 60_000) return void (item.next = item.settling + 60_000);
      item.settling = now;
      await this.near.callFunction(item.vault, "settle_solana", opArgs, "100000000000000", "0");
      this.log("worker.solana_settling", { vault: item.vault, opId: item.opId, signature });
      return void (item.next = now + FOLLOW_EVERY_MS);
    }
    if (status) {
      // Landed and failed (err), or not final yet: a failed one is freed once expired.
      if (status.err !== null && age >= SOLANA_EXPIRED_AFTER_MS) return await release();
      return void (item.next = now + FOLLOW_EVERY_MS);
    }
    if (age < REBROADCAST_WITHIN_MS) {
      await this.rpc<string>("sendTransaction", [
        Buffer.from(op.signed_transaction).toString("base64"),
        { encoding: "base64", skipPreflight: true, maxRetries: 0 },
      ]).catch(() => undefined);
      return void (item.next = now + 5_000);
    }
    if (age >= SOLANA_EXPIRED_AFTER_MS) return await release();
    item.next = Math.min(signedAt + SOLANA_EXPIRED_AFTER_MS, now + FOLLOW_EVERY_MS);
  }
}
