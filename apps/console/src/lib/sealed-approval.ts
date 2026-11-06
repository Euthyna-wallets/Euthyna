/**
 * Sealed orders sign Base transactions through the vault and NEAR MPC: a router approval (in a DAO
 * vote, or placed by a member of the role) and each fill's swap. NEAR cannot post them to Base: the
 * member who sent the NEAR transaction does, from their browser, right after it. Nothing is sent when
 * the transaction is already on Base. Broadcasting a signed transaction moves nothing the vault did not sign.
 */
import { bytesToHex, createPublicClient, http, keccak256, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

import { nearRpcMethod, viewContract } from "../wallets.js";

const base = createPublicClient({ chain: baseSepolia, transport: http(import.meta.env.VITE_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org") });

type Outcome = { receipts_outcome: Array<{ outcome: { logs: string[] } }> };
type Operation = { state: string; signed_transaction?: number[] | null };

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
  const outcome = await nearRpcMethod<Outcome>("tx", { tx_hash: transactionHash, sender_account_id: signerId, wait_until: "FINAL" });
  const sent: Hex[] = [];
  for (const opId of sealedApprovalsIn(outcome.receipts_outcome.flatMap((receipt) => receipt.outcome.logs), vaultAccountId)) {
    // Read from the vault itself, not from the log: the bytes MPC signed.
    const operation = await viewContract<Operation | null>(vaultAccountId, "get_operation", { op_id: opId });
    if (!operation?.signed_transaction || operation.state !== "PossiblySigned") continue;
    const raw = bytesToHex(Uint8Array.from(operation.signed_transaction));
    const hash = keccak256(raw);
    const known = await base.getTransaction({ hash }).catch(() => null);
    if (!known) await base.sendRawTransaction({ serializedTransaction: raw });
    sent.push(hash);
  }
  return sent;
}
