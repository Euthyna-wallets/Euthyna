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

export interface VaultOperation {
  op_id: Bytes32;
  client_id: string;
  agent: string;
  role: string;
  intent: PaymentIntent;
  policy_version: number;
  registry_version: number;
  evm_nonce: number;
  transaction: VaultTransaction;
  tx_digest: Bytes32;
  expires_at_block: number;
  state: "Prepared" | "PossiblySigned" | "Confirmed" | "Cancelled" | "Expired";
  signed_transaction: number[] | null;
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
  expires_at_block: number;
}

export interface StatusReport {
  client_id: string;
  op_id: Bytes32;
  kind: "Confirmed";
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
