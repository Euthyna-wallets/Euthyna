import type { Hex } from "viem";

export type Bytes20 = number[];
export type Bytes32 = number[];

export interface VaultTransaction {
  chain_id: number;
  nonce: number;
  to: Bytes20;
  value: string;
  input: number[];
  gas_limit: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
}

export interface PaymentIntent {
  token: Bytes20;
  recipient: Bytes20;
  amount: string;
  reference: string;
  gas_limit: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
}

export interface OperationRequest {
  chain_id: number;
  target: Bytes20;
  value: string;
  calldata: number[];
  allowance_amount: string;
  reference: string;
  gas_limit: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
}

export interface MpcSignature {
  big_r: number[];
  s: Bytes32;
  recovery_id: number;
}

export interface CancellationAttempt {
  transaction: VaultTransaction;
  tx_digest: Bytes32;
  signature: MpcSignature | null;
  signed_transaction: number[] | null;
  requested_at_ns: string;
  request_count: number;
}

export interface VaultOperation {
  op_id: Bytes32;
  client_id: string;
  member: string;
  role: string;
  request: OperationRequest;
  permission_index: number;
  /** Allowances charged by the matched permission's conditions (amounts measured by the vault). */
  consumptions: Array<{ key: Bytes32; amount: string; calls_only: boolean }>;
  /** Largest value the vault measured; null when nothing measures it (thresholds then apply). */
  measured_value: string | null;
  policy_version: number;
  registry_version: number;
  evm_nonce: number;
  transaction: VaultTransaction;
  tx_digest: Bytes32;
  created_at_ns: string;
  expires_at_ns: string;
  execute_after_ns: string | null;
  visa_authorized: boolean;
  cosigned_by: string | null;
  possibly_signed_at_ns: string | null;
  state: "Prepared" | "Queued" | "PossiblySigned" | "Confirmed" | "Failed" | "Cancelled" | "Vetoed" | "Expired";
  signature: MpcSignature | null;
  signed_transaction: number[] | null;
  cancellation: CancellationAttempt | null;
}

export interface GuardVisa {
  client_id: string;
  op_id: Bytes32;
  tx_digest: Bytes32;
  agent: string;
  role: string;
  reference: string;
  policy_version: number;
  registry_version: number;
  visa_nonce: number;
  expires_at_ns: string;
}

export interface StatusReport {
  client_id: string;
  op_id: Bytes32;
  kind: "Confirmed" | "Failed";
  tx_hash: Bytes32;
  report_nonce: number;
  block_number: number;
}
export interface SignedPayload<T> {
  report?: T;
  visa?: T;
  signature: string;
}

