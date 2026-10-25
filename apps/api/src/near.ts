import { keyStores, KeyPair, Near, transactions, utils, type Account } from "near-api-js";
import type { Env } from "./env.js";
import type { MpcSignature, VaultOperation } from "./types.js";

interface RpcResponse<T> {
  result?: T;
  error?: { message: string; data?: unknown };
}
class NearRpcApplicationError extends Error {}


type NearOutcome = {
  outcome?: { status?: { SuccessValue?: string; Failure?: unknown } };
};

export type NearTransactionStatus = {
  transaction_outcome?: NearOutcome;
  receipts_outcome?: NearOutcome[];
};

function hexBytes(value: unknown, expectedLength: number): number[] | null {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-fA-F]{${expectedLength * 2}}$`).test(value)) return null;
  return Array.from(Buffer.from(value, "hex"));
}

export function extractMpcSignatures(status: NearTransactionStatus): MpcSignature[] {
  const signatures: MpcSignature[] = [];
  const outcomes = [status.transaction_outcome, ...(status.receipts_outcome ?? [])];
  for (const outcome of outcomes) {
    const encoded = outcome?.outcome?.status?.SuccessValue;
    if (!encoded) continue;
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || !("scheme" in value) || value.scheme !== "Secp256k1") continue;
    const response = value as {
      big_r?: { affine_point?: unknown };
      s?: { scalar?: unknown };
      recovery_id?: unknown;
    };
    const bigR = hexBytes(response.big_r?.affine_point, 33);
    const scalar = hexBytes(response.s?.scalar, 32);
    if (!bigR || !scalar || !Number.isInteger(response.recovery_id) || Number(response.recovery_id) < 0 || Number(response.recovery_id) > 1) continue;
    signatures.push({
      big_r: bigR,
      s: scalar,
      recovery_id: Number(response.recovery_id),
    });
  }
  return signatures;
}

export class NearClient {
  private readonly accountPromise: Promise<Account>;
  private rpcQueue: Promise<void> = Promise.resolve();
  private nextRpcAt = 0;

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

  private async requestRpc<T>(method: string, params: unknown): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await fetch(this.env.NEAR_RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "mandateos", method, params }),
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 429 && attempt < 4) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0
            ? retryAfter * 1_000
            : 1_000 * (2 ** attempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
        const payload = (await response.json()) as RpcResponse<T>;
        if (payload.error) {
          throw new NearRpcApplicationError(
            `NEAR RPC ${payload.error.message}: ${JSON.stringify(payload.error.data ?? null)}`,
          );
        }
        if (payload.result === undefined) throw new Error("NEAR RPC response missing result");
        return payload.result;
      } catch (error) {
        if (error instanceof NearRpcApplicationError) throw error;
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_000 * (2 ** attempt)));
      }
    }
    throw new Error("NEAR RPC retry budget exhausted");
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const previous = this.rpcQueue;
    let release!: () => void;
    this.rpcQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const pacingDelay = Math.max(0, this.nextRpcAt - Date.now());
      if (pacingDelay > 0) await new Promise((resolve) => setTimeout(resolve, pacingDelay));
      return await this.requestRpc<T>(method, params);
    } finally {
      this.nextRpcAt = Date.now() + 500;
      release();
    }
  }

  async proxyRpc<T>(method: string, params: unknown): Promise<T> {
    return this.requestRpc<T>(method, params);
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
    // Reads use final blocks: an operation the agent just prepared can take a couple of seconds to show up.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const operation = await this.callView<VaultOperation | null>(vaultAccountId, "get_operation", { op_id: opId });
      if (operation) return operation;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    throw new Error("operation not found");
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

  async provisionFunctionCallAccount(input: {
    accountId: string;
    publicKey: string;
    receiverId: string;
    methodNames: string[];
    reserveYocto: string;
    allowanceYocto: null;
  }): Promise<string> {
    const account = await this.accountPromise;
    const outcome = await account.signAndSendTransaction({
      receiverId: input.accountId,
      actions: [
        transactions.createAccount(),
        transactions.transfer(BigInt(input.reserveYocto)),
        transactions.addKey(
          utils.PublicKey.fromString(input.publicKey),
          transactions.functionCallAccessKey(
            input.receiverId,
            input.methodNames,
          ),
        ),
      ],
    });
    return outcome.transaction_outcome.id;
  }

  async getAccount(accountId: string): Promise<{
    code_hash: string;
    amount: string;
    storage_usage?: number;
    global_contract_hash?: string;
    global_contract_account_id?: string;
  }> {
    return this.rpc("query", {
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

  async reportStatus(vaultAccountId: string, signedReport: unknown, mpcSignature?: MpcSignature): Promise<string> {
    return this.functionCall(
      vaultAccountId,
      "report_status",
      mpcSignature ? { signed_report: signedReport, mpc_signature: mpcSignature } : { signed_report: signedReport },
      "30000000000000",
    );
  }

  async submitSignature(vaultAccountId: string, opId: number[], signature: MpcSignature): Promise<string> {
    return this.functionCall(
      vaultAccountId,
      "submit_signature",
      { op_id: opId, signature },
      "50000000000000",
    );
  }

  async expireOperation(vaultAccountId: string, opId: number[]): Promise<string> {
    return this.functionCall(vaultAccountId, "expire_operation", { op_id: opId }, "30000000000000");
  }

  async executeQueuedOperation(vaultAccountId: string, opId: number[]): Promise<string> {
    return this.functionCall(vaultAccountId, "execute_queued_operation", { op_id: opId }, "60000000000000");
  }

  async currentBlockHeight(): Promise<number> {
    const block = await this.rpc<{ header: { height: number } }>("block", { finality: "final" });
    return block.header.height;
  }

  async currentBlockTimestampNs(): Promise<bigint> {
    const block = await this.rpc<{ header: { timestamp_nanosec: string } }>("block", { finality: "final" });
    return BigInt(block.header.timestamp_nanosec);
  }

  async transactionStatus(txHash: string, senderAccountId: string): Promise<NearTransactionStatus> {
    try {
      return await this.rpc<NearTransactionStatus>("tx", {
        tx_hash: txHash,
        sender_account_id: senderAccountId,
        wait_until: "FINAL",
      });
    } catch {
      return this.rpc<NearTransactionStatus>("EXPERIMENTAL_tx_status", [txHash, senderAccountId]);
    }
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

  /** Function call signed by the relayer (MandateOS pays gas and deposits). */
  async callFunction(
    contractId: string,
    methodName: string,
    args: Record<string, unknown>,
    gas: string,
    depositYocto: string,
  ): Promise<string> {
    const account = await this.accountPromise;
    const outcome = await account.functionCall({
      contractId,
      methodName,
      args,
      gas: BigInt(gas),
      attachedDeposit: BigInt(depositYocto),
    });
    return outcome.transaction.hash;
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
