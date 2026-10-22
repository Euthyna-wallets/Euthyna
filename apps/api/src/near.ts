import { keyStores, KeyPair, Near, transactions, utils, type Account } from "near-api-js";
import type { Env } from "./env.js";
import type { MpcSignature, VaultOperation } from "./types.js";

interface RpcResponse<T> {
  result?: T;
  error?: { message: string; data?: unknown };
}

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
    return this.functionCall(vaultAccountId, "expire", { op_id: opId }, "30000000000000");
  }

  async currentBlockHeight(): Promise<number> {
    const block = await this.rpc<{ header: { height: number } }>("block", { finality: "final" });
    return block.header.height;
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
