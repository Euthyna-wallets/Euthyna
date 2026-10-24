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
  allowance_key: Bytes32 | null;
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

export interface GovernanceOperation {
  op_id: Bytes32;
  proposer: string;
  target: Bytes20;
  value: string;
  data: number[];
  operation: 0 | 1;
  evm_nonce: number;
  transaction: VaultTransaction;
  tx_digest: Bytes32;
  possibly_signed_at_block: number;
  state: "PossiblySigned" | "Confirmed" | "Cancelled" | "Executed" | "Vetoed" | "Expired" | "Failed";
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
export type RelayFinalStatus = "Executed" | "Vetoed" | "Expired" | "Failed";

export interface RelayStatusReport {
  client_id: string;
  op_id: Bytes32;
  final_status: RelayFinalStatus;
  tx_hash: Bytes32;
  report_nonce: number;
  block_number: number;
}


export interface SignedPayload<T> {
  report?: T;
  visa?: T;
  signature: string;
}

export interface Registry {
  clientId: string;
  registryVersion: number;
  network: "base-sepolia";
  chainId: 84532;
  token: { symbol: "USDC"; address: Hex | null; decimals: 6 };
  roles: Record<
    string,
    {
      maximumPayment: string;
      vendors: Array<{
        id: string;
        name: string;
        addresses: Array<{ address: Hex; maximumPayment?: string }>;
      }>;
    }
  >;
}
