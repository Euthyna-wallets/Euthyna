/**
 * Sponsored execution (EIP-7702): once a company votes `SetEvmExecutor`, its wallet must delegate
 * its code to that executor. The keeper has the vault sign the authorization (NEAR MPC, through
 * `delegate_wallet`) and submits it in a type-4 transaction the gas tank pays for. Idempotent:
 * a wallet whose code already points to the executor is left alone.
 */
import type { Address, Hex } from "viem";

export interface DelegationNear {
  viewFunction<T>(accountId: string, methodName: string, args?: Record<string, unknown>): Promise<T>;
  delegateWallet(vaultAccountId: string, chainId: number): Promise<string>;
}
export interface DelegationChain {
  code(address: Address): Promise<Hex | undefined>;
  delegate(authorization: { chainId: number; address: Address; nonce: number; r: Hex; s: Hex; yParity: number }): Promise<Hex>;
}

type Delegation = { executor: number[]; nonce: number; signature: { big_r: number[]; s: number[]; recovery_id: number } | null };

const hex = (bytes: number[]) => `0x${Buffer.from(bytes).toString("hex")}` as Hex;

/** What the keeper did for one vault: nothing to do, asked the vault to sign, or submitted the authorization. */
export async function keepDelegated(near: DelegationNear, chain: DelegationChain, vaultAccountId: string, chainId: number): Promise<"none" | "delegated" | "signing" | "submitted"> {
  const executor = await near.viewFunction<string | null>(vaultAccountId, "get_evm_executor", { chain_id: chainId }).catch(() => null);
  if (!executor) return "none";
  const wallet = await near.viewFunction<{ address: number[] | null }>(vaultAccountId, "get_wallet", { chain_id: chainId });
  if (!wallet.address) return "none";
  const address = hex(wallet.address) as Address;
  const code = (await chain.code(address)) ?? "0x";
  // EIP-7702 delegation indicator: 0xef0100 || executor.
  if (code.toLowerCase() === `0xef0100${executor.slice(2).toLowerCase()}`) return "delegated";
  const delegation = await near.viewFunction<Delegation | null>(vaultAccountId, "get_wallet_delegation", { chain_id: chainId });
  if (!delegation?.signature || hex(delegation.executor).toLowerCase() !== executor.toLowerCase()) {
    await near.delegateWallet(vaultAccountId, chainId);
    return "signing";
  }
  const { big_r, s, recovery_id } = delegation.signature;
  await chain.delegate({
    chainId,
    address: executor as Address,
    nonce: delegation.nonce,
    r: hex(big_r.slice(1, 33)),
    s: hex(s),
    yParity: recovery_id,
  });
  return "submitted";
}
