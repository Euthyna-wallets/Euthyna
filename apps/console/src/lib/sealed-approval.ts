/**
 * Sealed orders sign Base transactions through the vault and NEAR MPC: a router approval (in a DAO
 * vote, or placed by a member of the role) and each fill's swap. NEAR cannot post them to Base: the
 * member who sent the NEAR transaction does, from their browser, right after it. Nothing is sent when
 * the transaction is already on Base. Broadcasting a signed transaction moves nothing the vault did not sign.
 */
import { bytesToHex, createPublicClient, http, keccak256, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

import { omni } from "../omniroles-api.js";
import { nearRpcMethod, signContractCall, viewContract } from "../wallets.js";

const base = createPublicClient({ chain: baseSepolia, transport: http(import.meta.env.VITE_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org") });

type Outcome = { receipts_outcome: Array<{ outcome: { logs: string[] } }> };
type Operation = { state: string; signed_transaction?: number[] | null };

// The operations this browser posted to Base, by vault, until the vault records them (settle).
const PENDING = (vault: string) => `euthyna.sealed.pending.${vault}`;
function pendingOf(vault: string): number[][] {
  try { return JSON.parse(localStorage.getItem(PENDING(vault)) ?? "[]") as number[][]; } catch { return []; }
}
function keepPending(vault: string, ops: number[][]) {
  try { localStorage.setItem(PENDING(vault), JSON.stringify(ops)); } catch { /* storage off: the button just will not show */ }
}

export type Settlement = { opId: number[]; state: "ready" | "waiting" | "reverted"; blockHash?: Hex; baseTransaction: Hex };

/**
 * Swaps and approvals this browser posted that the vault has not recorded yet. A mined one becomes
 * "ready" once its Base block is final (about 20 minutes on Base Sepolia); recording it (settle)
 * turns the budget it reserved into spent. A reverted one stays reserved until the vault releases it.
 */
export async function pendingSettlements(vaultAccountId: string): Promise<Settlement[]> {
  const out: Settlement[] = [];
  const still: number[][] = [];
  const finalized = await base.getBlock({ blockTag: "finalized" }).catch(() => null);
  for (const opId of pendingOf(vaultAccountId)) {
    const operation = await viewContract<Operation | null>(vaultAccountId, "get_operation", { op_id: opId }).catch(() => undefined);
    if (operation === undefined) { still.push(opId); continue; }
    if (!operation || operation.state !== "PossiblySigned" || !operation.signed_transaction) continue;
    still.push(opId);
    const baseTransaction = keccak256(bytesToHex(Uint8Array.from(operation.signed_transaction)));
    const receipt = await base.getTransactionReceipt({ hash: baseTransaction }).catch(() => null);
    if (!receipt) out.push({ opId, state: "waiting", baseTransaction });
    else if (receipt.status !== "success") out.push({ opId, state: "reverted", baseTransaction });
    else out.push({ opId, state: finalized && finalized.number >= receipt.blockNumber ? "ready" : "waiting", blockHash: receipt.blockHash, baseTransaction });
  }
  keepPending(vaultAccountId, still);
  return out;
}

/** Records final swaps on the vault from the member's wallet (anyone may; the vault checks the receipt through NEAR MPC). */
export async function recordSettlements(me: string, vaultAccountId: string, ready: Settlement[]): Promise<number> {
  for (const item of ready) {
    if (item.state !== "ready" || !item.blockHash) continue;
    const hash = item.blockHash.slice(2).match(/../g)!.map((pair) => parseInt(pair, 16));
    await signContractCall(me, vaultAccountId, "settle", { op_id: item.opId, block_hash: hash }, { gas: "70000000000000" });
  }
  return ready.filter((item) => item.state === "ready").length;
}

/** The Base operations for this vault (router approvals, fills) that a transaction's logs say were signed. */
export function sealedApprovalsIn(logs: string[], vaultAccountId: string, events: string[] = ["approved", "filled"]): number[][] {
  const found: number[][] = [];
  for (const line of logs) {
    if (!line.startsWith("EVENT_JSON:")) continue;
    try {
      const event = JSON.parse(line.slice("EVENT_JSON:".length)) as { standard?: string; event?: string; data?: Array<{ vault?: string; op_id?: number[] }> };
      if (event.standard !== "euthyna-sealed-orders" || !events.includes(event.event ?? "")) continue;
      for (const entry of event.data ?? []) {
        if (entry.vault === vaultAccountId && Array.isArray(entry.op_id) && entry.op_id.length === 32) found.push(entry.op_id);
      }
    } catch { /* another contract's log */ }
  }
  return found;
}

/** After a vote, a seal or a fill: posts what it had signed to Base. Returns the Base transaction hashes. */
export async function sendSealedApprovals(transactionHash: string, signerId: string, vaultAccountId: string): Promise<Hex[]> {
  // A final outcome can take longer than one RPC call waits (HTTP 408): ask again for a minute.
  let outcome: Outcome | null = null;
  for (let attempt = 0; attempt < 6 && !outcome; attempt++) {
    outcome = await nearRpcMethod<Outcome>("tx", { tx_hash: transactionHash, sender_account_id: signerId, wait_until: "FINAL" }).catch((error: unknown) => {
      if (attempt === 5) throw error;
      return null;
    });
    if (!outcome) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  const sent: Hex[] = [];
  for (const opId of sealedApprovalsIn(outcome!.receipts_outcome.flatMap((receipt) => receipt.outcome.logs), vaultAccountId)) {
    // A company with sponsored gas: the vault signed an authorization for its executor, not a raw
    // transaction; Euthyna's relayer sends it. Tell it now, rather than on its next round.
    if (await viewContract<unknown>(vaultAccountId, "get_sponsored_operation", { op_id: opId }).catch(() => null)) {
      await omni.sealedAnnounce(bytesToHex(Uint8Array.from(opId))).catch(() => undefined);
      continue;
    }
    // Read from the vault itself, not from the log: the bytes MPC signed.
    const operation = await viewContract<Operation | null>(vaultAccountId, "get_operation", { op_id: opId });
    if (!operation?.signed_transaction || operation.state !== "PossiblySigned") continue;
    const raw = bytesToHex(Uint8Array.from(operation.signed_transaction));
    const hash = keccak256(raw);
    const known = await base.getTransaction({ hash }).catch(() => null);
    if (!known) await base.sendRawTransaction({ serializedTransaction: raw });
    keepPending(vaultAccountId, [...pendingOf(vaultAccountId).filter((item) => item.join() !== opId.join()), opId]);
    sent.push(hash);
  }
  return sent;
}
