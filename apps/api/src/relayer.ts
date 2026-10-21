import { createPublicClient, http, keccak256, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import type { Env } from "./env.js";
import { signedTransaction } from "./evm.js";
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
    this.client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  }

  async broadcastAndConfirm(vaultAccountId: string, operation: VaultOperation) {
    if (operation.state !== "PossiblySigned") throw new Error("operation is not PossiblySigned");
    const raw = signedTransaction(operation);
    const localHash = keccak256(raw);
    const hash = await this.client.sendRawTransaction({ serializedTransaction: raw });
    if (hash !== localHash) throw new Error("Base RPC returned a different transaction hash");
    const receipt = await this.client.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success") throw new Error(`Base transaction ${hash} reverted`);
    const signedReport = await this.guard.confirmationReport(operation, hash as Hex, receipt.blockNumber);
    const nearTransactionHash = await this.near.reportStatus(vaultAccountId, signedReport);
    return { hash, blockNumber: receipt.blockNumber.toString(), nearTransactionHash };
  }
}

export function createBaseRelayer(env: Env, near: NearClient, guard: Guard): BaseRelayer {
  return new BaseRelayer(env.BASE_SEPOLIA_RPC_URL, near, guard);
}
