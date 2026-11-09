import { bytesToHex, createPublicClient, http, keccak256, TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
import type { Env } from "./env.js";
import { GasTank, type WalletAuthorization } from "./gas-tank.js";
import { Guard } from "./guard.js";
import { NearClient } from "./near.js";
import type { VaultOperation } from "./types.js";

/** keccak256("Executed(bytes32)") */
export const EXECUTED_TOPIC = "0xa74c8847d513feba22a0f0cb38d53081abf97562cdb293926ba243689e7c41ca";

export class BaseRelayer {
  private readonly client;

  constructor(
    rpcUrl: string,
    private readonly near: NearClient,
    private readonly guard: Guard,
    private readonly gasTank: GasTank | null = null,
    /** The block tag the vault's attestation asks for: `safe` on testnet, `finalized` on mainnet. */
    private readonly settleAt: "safe" | "finalized" = "finalized",
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

  /** Sponsored execution: the relayer (the gas tank) sends the wallet's signed `execute` call. */
  async relay(wallet: Address, calldata: number[], authorization?: WalletAuthorization): Promise<Hex> {
    if (!this.gasTank) throw new Error("sponsored execution needs BASE_GAS_TANK_PRIVATE_KEY (the relayer that pays the gas)");
    return this.gasTank.relay(wallet, bytesToHex(Uint8Array.from(calldata)), authorization);
  }

  async nonce(address: Address): Promise<number> {
    return this.client.getTransactionCount({ address, blockTag: "pending" });
  }

  async code(address: Address): Promise<Hex | undefined> {
    return this.client.getCode({ address });
  }

  /** Submits a wallet's EIP-7702 authorization; the tank pays. */
  async delegate(authorization: { chainId: number; address: Address; nonce: number; r: Hex; s: Hex; yParity: number }): Promise<Hex> {
    if (!this.gasTank) throw new Error("delegation needs BASE_GAS_TANK_PRIVATE_KEY");
    return this.gasTank.delegate(authorization);
  }

  /** The wallet's `Executed(opId)` log in a receipt, with what the vault binds into its MPC proof. */
  async executedLog(hash: Hex, wallet: Address, opId: Hex): Promise<{ blockHash: Hex; blockNumber: bigint; transactionIndex: number; logIndex: number } | null> {
    const receipt = await this.client.getTransactionReceipt({ hash }).catch(() => null);
    if (!receipt || receipt.status !== "success") return null;
    const log = receipt.logs.find((entry) => entry.address.toLowerCase() === wallet.toLowerCase()
      && entry.topics[0]?.toLowerCase() === EXECUTED_TOPIC && entry.topics[1]?.toLowerCase() === opId.toLowerCase());
    if (!log || log.logIndex === null || log.transactionIndex === null) return null;
    return { blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, transactionIndex: log.transactionIndex, logIndex: log.logIndex };
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

  /** The newest block NEAR MPC will attest (the vault asks `Safe` on testnet, `Finalized` on mainnet). */
  async finalizedBlockNumber(): Promise<bigint> {
    return (await this.client.getBlock({ blockTag: this.settleAt })).number;
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
  return new BaseRelayer(env.BASE_SEPOLIA_RPC_URL, near, guard, tank, env.NEAR_NETWORK_ID === "testnet" ? "safe" : "finalized");
}

/** Relayers for the other EVM chains a company wallet can act on, by chain id. */
export function createChainRelayers(env: Env, near: NearClient, guard: Guard): Record<number, BaseRelayer> {
  return { 11155111: new BaseRelayer(env.ETHEREUM_SEPOLIA_RPC_URL, near, guard, null, env.NEAR_NETWORK_ID === "testnet" ? "safe" : "finalized") };
}

