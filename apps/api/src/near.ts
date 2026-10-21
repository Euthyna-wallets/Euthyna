import { keyStores, KeyPair, Near, type Account } from "near-api-js";
import type { Env } from "./env.js";
import type { VaultOperation } from "./types.js";

interface RpcResponse<T> {
  result?: T;
  error?: { message: string; data?: unknown };
}

export class NearClient {
  private readonly accountPromise: Promise<Account>;

  constructor(private readonly env: Pick<Env, "NEAR_NETWORK_ID" | "NEAR_RPC_URL" | "NEAR_RELAYER_ACCOUNT_ID" | "NEAR_RELAYER_PRIVATE_KEY">) {
    this.accountPromise = this.createRelayerAccount();
  }

  private async createRelayerAccount(): Promise<Account> {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(
      this.env.NEAR_NETWORK_ID,
      this.env.NEAR_RELAYER_ACCOUNT_ID,
      KeyPair.fromString(this.env.NEAR_RELAYER_PRIVATE_KEY as `ed25519:${string}`),
    );
    const near = new Near({
      networkId: this.env.NEAR_NETWORK_ID,
      nodeUrl: this.env.NEAR_RPC_URL,
      keyStore,
    });
    return near.account(this.env.NEAR_RELAYER_ACCOUNT_ID);
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const response = await fetch(this.env.NEAR_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "mandateos", method, params }),
    });
    if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
    const payload = (await response.json()) as RpcResponse<T>;
    if (payload.error) throw new Error(`NEAR RPC ${payload.error.message}`);
    if (payload.result === undefined) throw new Error("NEAR RPC response missing result");
    return payload.result;
  }

  async getOperation(vaultAccountId: string, opId: number[]): Promise<VaultOperation> {
    const result = await this.rpc<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: vaultAccountId,
      method_name: "get_operation",
      args_base64: Buffer.from(JSON.stringify({ op_id: opId })).toString("base64"),
    });
    const operation = JSON.parse(Buffer.from(result.result).toString("utf8")) as VaultOperation | null;
    if (!operation) throw new Error("operation not found");
    return operation;
  }

  async reportStatus(vaultAccountId: string, signedReport: unknown): Promise<string> {
    return this.functionCall(vaultAccountId, "report_status", { signed_report: signedReport }, "30000000000000");
  }

  async cancelNonce(
    vaultAccountId: string,
    opId: number[],
    gasLimit: string,
    maxFeePerGas: string,
    maxPriorityFeePerGas: string,
  ): Promise<string> {
    return this.functionCall(
      vaultAccountId,
      "cancel_nonce",
      {
        op_id: opId,
        gas_limit: gasLimit,
        max_fee_per_gas: maxFeePerGas,
        max_priority_fee_per_gas: maxPriorityFeePerGas,
      },
      "120000000000000",
    );
  }

  private async functionCall(
    contractId: string,
    methodName: string,
    args: Record<string, unknown>,
    gas: string,
  ): Promise<string> {
    const account = await this.accountPromise;
    const outcome = await account.functionCall({
      contractId,
      methodName,
      args,
      gas,
      attachedDeposit: "0",
    });
    return outcome.transaction.hash;
  }
}
