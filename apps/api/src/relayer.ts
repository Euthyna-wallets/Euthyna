import { bytesToHex, createPublicClient, http, keccak256, TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
import type { Env } from "./env.js";
import { GasTank } from "./gas-tank.js";
import { Guard } from "./guard.js";
import { NearClient } from "./near.js";
import type { VaultOperation } from "./types.js";

export class BaseRelayer {
  private readonly client;

  constructor(
    rpcUrl: string,
    private readonly near: NearClient,
    private readonly guard: Guard,
    private readonly gasTank: GasTank | null = null,
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
    // Testnet: the company wallet gets the fee it lacks for this very transaction (no-op when it has it).
    if (this.gasTank) await this.gasTank.topUpFor(raw).catch((error: unknown) => console.warn(JSON.stringify({ event: "gas_tank.failed", error: String(error).slice(0, 200) })));
    try {
      const hash = await this.client.sendRawTransaction({ serializedTransaction: raw });
      if (hash !== localHash) throw new Error("Base RPC returned a different transaction hash");
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (!message.includes("already known") && !message.includes("already imported")) throw error;
    }
    return localHash;
  }

  async receipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint; blockHash: Hex } | null> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash });
      return { status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
  }

  async finalizedBlockNumber(): Promise<bigint> {
    return (await this.client.getBlock({ blockTag: "finalized" })).number;
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
    if (receipt.blockNumber > await this.finalizedBlockNumber()) throw new Error("Transaction is not finalized; resume settlement later");
    const nearTransactionHash = await this.near.settle(vaultAccountId, operation.op_id, receipt.blockHash);
    return { hash, blockNumber: receipt.blockNumber.toString(), nearTransactionHash };
  }
}

export function createBaseRelayer(env: Env, near: NearClient, guard: Guard): BaseRelayer {
  const tank = env.BASE_GAS_TANK_PRIVATE_KEY && env.NEAR_NETWORK_ID === "testnet"
    ? new GasTank(env.BASE_GAS_TANK_PRIVATE_KEY as `0x${string}`, env.BASE_SEPOLIA_RPC_URL, 84532, BigInt(env.BASE_GAS_TANK_PER_WALLET_DAY_WEI))
    : null;
  if (tank) console.info(JSON.stringify({ event: "gas_tank.on", address: tank.address }));
  return new BaseRelayer(env.BASE_SEPOLIA_RPC_URL, near, guard, tank);
}

/** Relayers for the other EVM chains a company wallet can act on, by chain id. */
export function createChainRelayers(env: Env, near: NearClient, guard: Guard): Record<number, BaseRelayer> {
  return { 11155111: new BaseRelayer(env.ETHEREUM_SEPOLIA_RPC_URL, near, guard) };
}

