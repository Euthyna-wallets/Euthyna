import { keyStores, KeyPair, Near, transactions, type Account } from "near-api-js";
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

  private async callView<T>(accountId: string, methodName: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.rpc<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: accountId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    return JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
  }

  async getOperation(vaultAccountId: string, opId: number[]): Promise<VaultOperation> {
    const operation = await this.callView<VaultOperation | null>(vaultAccountId, "get_operation", { op_id: opId });
    if (!operation) throw new Error("operation not found");
    return operation;
  }

  async executeActions(
    receiverId: string,
    actions: Array<{
      type: "CreateAccount" | "Transfer" | "DeployContract" | "FunctionCall";
      depositYocto?: string;
      codeBase64?: string;
      methodName?: string;
      args?: Record<string, unknown>;
      gasTgas?: number;
    }>,
  ): Promise<string> {
    const account = await this.accountPromise;
    const mapped = actions.map((action) => {
      if (action.type === "CreateAccount") return transactions.createAccount();
      if (action.type === "Transfer") return transactions.transfer(BigInt(action.depositYocto ?? "0"));
      if (action.type === "DeployContract") {
        return transactions.deployContract(Uint8Array.from(Buffer.from(action.codeBase64 ?? "", "base64")));
      }
      return transactions.functionCall(
        action.methodName ?? "",
        action.args ?? {},
        BigInt(action.gasTgas ?? 100) * 1_000_000_000_000n,
        BigInt(action.depositYocto ?? "0"),
      );
    });
    const outcome = await account.signAndSendTransaction({ receiverId, actions: mapped });
    return outcome.transaction_outcome.id;
  }

  async createSubaccount(accountId: string, publicKey: string, amountYocto: string): Promise<string> {
    const account = await this.accountPromise;
    await account.createAccount(accountId, publicKey, amountYocto);
    return accountId;
  }

  async getAccount(accountId: string): Promise<{ code_hash: string; amount: string }> {
    return this.rpc<{ code_hash: string; amount: string }>("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
  }

  async getAccessKeys(accountId: string): Promise<{ keys: unknown[] }> {
    return this.rpc<{ keys: unknown[] }>("query", {
      request_type: "view_access_key_list",
      finality: "final",
      account_id: accountId,
    });
  }

  async viewFunction<T>(accountId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.callView<T>(accountId, methodName, args);
  }

  async derivedPublicKey(
    mpcContractId: string,
    predecessor: string,
    path: string,
    domainId: number,
  ): Promise<string> {
    return this.callView<string>(mpcContractId, "derived_public_key", {
      path,
      predecessor,
      domain_id: domainId,
    });
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
