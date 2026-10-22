import { decodeAgentEvmAddress } from "@mandateos/sdk";
import type { Address } from "viem";

export interface OnChainAgentState {
  role?: string;
  mpc_path?: string;
  active?: boolean;
  derived_public_key?: string | null;
  evm_address?: number[] | string | null;
}

export function onChainAgentEvmAddress(state: unknown): Address | null {
  if (!state || typeof state !== "object" || !("evm_address" in state)) return null;
  const value = (state as OnChainAgentState).evm_address;
  return decodeAgentEvmAddress(value);
}
