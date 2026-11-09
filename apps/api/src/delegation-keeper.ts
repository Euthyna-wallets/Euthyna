/**
 * Sponsored execution (EIP-7702): once a company votes `SetEvmExecutor`, its wallet must delegate
 * its code to that executor. The keeper has the vault sign the authorization (NEAR MPC, through
 * `delegate_wallet`) and submits it in a type-4 transaction the gas tank pays for. Idempotent:
 * a wallet whose code already points to the executor is left alone.
 */
import type { Address, Hex } from "viem";

import type { WalletAuthorization } from "./gas-tank.js";

export interface DelegationNear {
  viewFunction<T>(accountId: string, methodName: string, args?: Record<string, unknown>): Promise<T>;
  delegateWallet(vaultAccountId: string, chainId: number): Promise<string>;
}
export interface DelegationChain {
  code(address: Address): Promise<Hex | undefined>;
  delegate(authorization: WalletAuthorization): Promise<Hex>;
  /** The wallet's next nonce on chain (a signed authorization is valid only at that nonce). */
  nonce?(address: Address): Promise<number>;
}

type Delegation = { executor: number[]; nonce: number; signature: { big_r: number[]; s: number[]; recovery_id: number } | null };

const hex = (bytes: number[]) => `0x${Buffer.from(bytes).toString("hex")}` as Hex;

const authorizationOf = (chainId: number, executor: string, delegation: Delegation): WalletAuthorization => {
  const { big_r, s, recovery_id } = delegation.signature!;
  return { chainId, address: executor as Address, nonce: delegation.nonce, r: hex(big_r.slice(1, 33)), s: hex(s), yParity: recovery_id };
};

/**
 * The wallet's signed authorization when its code does not point to the voted executor yet: the
 * relayer sends it with a sponsored call, so the call never reaches a wallet without code.
 */
export async function pendingAuthorization(near: Pick<DelegationNear, "viewFunction">, chain: Pick<DelegationChain, "code">, vaultAccountId: string, chainId: number, wallet: Address): Promise<WalletAuthorization | null> {
  const executor = await near.viewFunction<string | null>(vaultAccountId, "get_evm_executor", { chain_id: chainId }).catch(() => null);
  if (!executor) return null;
  const code = (await chain.code(wallet)) ?? "0x";
  if (code.toLowerCase() === `0xef0100${executor.slice(2).toLowerCase()}`) return null;
  const delegation = await near.viewFunction<Delegation | null>(vaultAccountId, "get_wallet_delegation", { chain_id: chainId });
  if (!delegation?.signature || hex(delegation.executor).toLowerCase() !== executor.toLowerCase()) return null;
  return authorizationOf(chainId, executor, delegation);
}

/** What the keeper did for one vault: nothing to do, asked the vault to sign, or submitted the authorization. */
export async function keepDelegated(near: DelegationNear, chain: DelegationChain, vaultAccountId: string, chainId: number): Promise<"none" | "delegated" | "signing" | "submitted"> {
  const executor = await near.viewFunction<string | null>(vaultAccountId, "get_evm_executor", { chain_id: chainId }).catch(() => null);
  if (!executor) return "none";
  const wallet = await near.viewFunction<{ address: number[] | null }>(vaultAccountId, "get_wallet", { chain_id: chainId });
  if (!wallet.address) return "none";
  const address = hex(wallet.address) as Address;
  const code = (await chain.code(address)) ?? "0x";
  const delegated = code.toLowerCase() === `0xef0100${executor.slice(2).toLowerCase()}`; // 0xef0100 || executor
  const delegation = await near.viewFunction<Delegation | null>(vaultAccountId, "get_wallet_delegation", { chain_id: chainId });
  const signed = Boolean(delegation?.signature) && hex(delegation!.executor).toLowerCase() === executor.toLowerCase();
  // The vault gave this authorization the wallet's next nonce: until it is on chain, no later transaction
  // of the wallet can be mined. So it is submitted while unused, even if the code already points there.
  const unused = signed && chain.nonce ? (await chain.nonce(address)) === delegation!.nonce : !delegated;
  if (delegated && !unused) return "delegated";
  if (!signed) {
    if (delegated) return "delegated";
    await near.delegateWallet(vaultAccountId, chainId);
    return "signing";
  }
  await chain.delegate(authorizationOf(chainId, executor, delegation!));
  return "submitted";
}
