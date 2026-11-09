import {
  encodeFunctionData,
  erc20Abi,
  hashTypedData,
  bytesToHex,
  getAddress,
  hexToBytes,
  keccak256,
  serializeTransaction,
  type Address,
  type Hex,
} from "viem";
import type { VaultOperation } from "./types.js";

export function bytesToAddress(bytes: number[]): Address {
  if (bytes.length !== 20) throw new Error("expected 20-byte EVM address");
  return getAddress(bytesToHex(Uint8Array.from(bytes)));
}

export function bytes32ToHex(bytes: number[]): Hex {
  if (bytes.length !== 32) throw new Error("expected 32 bytes");
  return bytesToHex(Uint8Array.from(bytes));
}

export function digestVaultTransaction(operation: VaultOperation): Hex {
  const tx = operation.transaction;
  const serialized = serializeTransaction({
    type: "eip1559",
    chainId: tx.chain_id,
    nonce: tx.nonce,
    to: bytesToAddress(tx.to),
    value: BigInt(tx.value),
    data: bytesToHex(Uint8Array.from(tx.input)),
    gas: BigInt(tx.gas_limit),
    maxFeePerGas: BigInt(tx.max_fee_per_gas),
    maxPriorityFeePerGas: BigInt(tx.max_priority_fee_per_gas),
  });
  return keccak256(serialized);
}

/** A sponsored operation (EIP-7702): the wallet's EIP-712 `Execute` of the same call. */
export const EXECUTE_TYPES = {
  Execute: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "opId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function digestSponsoredExecute(operation: VaultOperation, wallet: `0x${string}`, deadline: bigint): Hex {
  return hashTypedData({
    domain: { name: "EuthynaExecutor", version: "1", chainId: operation.request.chain_id, verifyingContract: wallet },
    types: EXECUTE_TYPES,
    primaryType: "Execute",
    message: {
      to: bytesToAddress(operation.request.target),
      value: BigInt(operation.request.value),
      data: bytesToHex(Uint8Array.from(operation.request.calldata)),
      opId: bytesToHex(Uint8Array.from(operation.op_id)),
      deadline,
    },
  });
}

/** Approve + call + revoke under one EIP-712 `Batch` (sponsored operation with an approval). */
export const BATCH_TYPES = {
  Batch: [
    { name: "calls", type: "Call[]" },
    { name: "opId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
  Call: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
} as const;

export type SponsoredApproval = { token: number[]; amount: string };

/** The calls the wallet runs for an operation with a bundled approval: the spender is the call's target. */
export function batchCalls(operation: VaultOperation, approval: SponsoredApproval) {
  const target = bytesToAddress(operation.request.target);
  const token = bytesToAddress(approval.token);
  const approve = (amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [target, amount] });
  return [
    { to: token, value: 0n, data: approve(BigInt(approval.amount)) },
    { to: target, value: BigInt(operation.request.value), data: bytesToHex(Uint8Array.from(operation.request.calldata)) },
    { to: token, value: 0n, data: approve(0n) },
  ];
}

export function digestSponsoredBatch(operation: VaultOperation, wallet: `0x${string}`, deadline: bigint, approval: SponsoredApproval): Hex {
  return hashTypedData({
    domain: { name: "EuthynaExecutor", version: "1", chainId: operation.request.chain_id, verifyingContract: wallet },
    types: BATCH_TYPES,
    primaryType: "Batch",
    message: { calls: batchCalls(operation, approval), opId: bytesToHex(Uint8Array.from(operation.op_id)), deadline },
  });
}

export function signedTransaction(operation: VaultOperation): Hex {
  if (!operation.signed_transaction) throw new Error("operation has no stored MPC signature");
  return bytesToHex(Uint8Array.from(operation.signed_transaction));
}

export function hexToByteArray(value: Hex): number[] {
  return Array.from(hexToBytes(value));
}
