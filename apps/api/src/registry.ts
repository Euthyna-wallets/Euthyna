import { bytesToHex, decodeFunctionData, erc20Abi, getAddress, type Address } from "viem";

import { bytesToAddress } from "./evm.js";
import type { VaultOperation } from "./types.js";

/**
 * What the Guard knows that the vault does not: which addresses are real
 * suppliers (names, four-eyes registry) and which is the company's own wallet.
 * The vault already enforced the role (contracts, functions, parameters, budgets).
 */
export interface GuardContext {
  suppliers: Array<{ id: string; name: string; address: Address }>;
  companyWallet: Address | null;
}

export type GuardDecision =
  | { decision: "approve"; vendorId: string | null; vendorName: string | null }
  | { decision: "refuse"; reasons: string[] };

/**
 * Off-chain second check before the Guard signs a visa. Either it passes or the
 * operation is refused: there is no human escalation. Anything else must be
 * voted by the DAO as a transaction proposal.
 */
export function evaluateOperation(context: GuardContext, operation: VaultOperation): GuardDecision {
  let transfer: { recipient: Address; amount: bigint } | null = null;
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: bytesToHex(Uint8Array.from(operation.request.calldata)) });
    if (decoded.functionName === "transfer") transfer = { recipient: decoded.args[0], amount: decoded.args[1] };
  } catch {
    transfer = null;
  }
  // Swaps, approvals and other protocol calls are fully described by the role.
  if (!transfer) return { decision: "approve", vendorId: null, vendorName: null };
  const recipient = getAddress(transfer.recipient);
  if (context.companyWallet && recipient === getAddress(context.companyWallet)) {
    return { decision: "approve", vendorId: null, vendorName: "company wallet" };
  }
  const supplier = context.suppliers.find((item) => getAddress(item.address) === recipient);
  if (!supplier) {
    return { decision: "refuse", reasons: [`${recipient} is not a registered supplier (token ${bytesToAddress(operation.request.target)})`] };
  }
  return { decision: "approve", vendorId: supplier.id, vendorName: supplier.name };
}
