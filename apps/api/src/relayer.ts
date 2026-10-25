import { bytesToHex, createPublicClient, http, keccak256, TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
import type { Env } from "./env.js";
import { Guard } from "./guard.js";
import { NearClient } from "./near.js";
import type { VaultOperation } from "./types.js";

export class BaseRelayer {
  private readonly client;

  constructor(
    rpcUrl: string,
    private readonly near: NearClient,
    private readonly guard: Guard,
  ) {
    // Chain-agnostic JSON-RPC: the same relayer serves Base and the other EVM chains.
    this.client = createPublicClient({ transport: http(rpcUrl) });
  }

  transactionHash(operation: VaultOperation): Hex {
    return this.rawTransactionHash(operation.signed_transaction);
  }

  rawTransactionHash(rawTransaction: number[] | null): Hex {
    if (!rawTransaction) throw new Error("operation has no stored signed transaction");
    return keccak256(bytesToHex(Uint8Array.from(rawTransaction)));
  }

  async broadcast(operation: VaultOperation): Promise<Hex> {
    return this.broadcastRaw(operation.signed_transaction);
  }

  async broadcastRaw(rawTransaction: number[] | null): Promise<Hex> {
    if (!rawTransaction) throw new Error("operation has no stored signed transaction");
    const raw = bytesToHex(Uint8Array.from(rawTransaction));
    const localHash = keccak256(raw);
    try {
      const hash = await this.client.sendRawTransaction({ serializedTransaction: raw });
      if (hash !== localHash) throw new Error("Base RPC returned a different transaction hash");
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (!message.includes("already known") && !message.includes("already imported")) throw error;
    }
    return localHash;
  }

  async receipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint } | null> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash });
      return { status: receipt.status, blockNumber: receipt.blockNumber };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
  }

  async blockNumber(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  async balance(address: Address): Promise<bigint> {
    return this.client.getBalance({ address });
  }

  async broadcastAndConfirm(vaultAccountId: string, operation: VaultOperation) {
    if (operation.state !== "PossiblySigned") throw new Error("operation is not PossiblySigned");
    const hash = await this.broadcast(operation);
    const receipt = await this.client.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success") throw new Error(`Base transaction ${hash} reverted`);
    const signedReport = await this.guard.confirmationReport(operation, hash, receipt.blockNumber);
    const nearTransactionHash = await this.near.reportStatus(vaultAccountId, signedReport);
    return { hash, blockNumber: receipt.blockNumber.toString(), nearTransactionHash };
  }
}

export function createBaseRelayer(env: Env, near: NearClient, guard: Guard): BaseRelayer {
  return new BaseRelayer(env.BASE_SEPOLIA_RPC_URL, near, guard);
}

/** Relayers for the other EVM chains a company wallet can act on, by chain id. */
export function createChainRelayers(env: Env, near: NearClient, guard: Guard): Record<number, BaseRelayer> {
  return { 11155111: new BaseRelayer(env.ETHEREUM_SEPOLIA_RPC_URL, near, guard) };
}
