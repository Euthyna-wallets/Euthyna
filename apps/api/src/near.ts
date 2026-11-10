import { hexToBytes, type Hex } from "viem";
import { transactions, utils, type Account } from "near-api-js";
import type { Env } from "./env.js";
import { RpcLimiter } from "./rpc-limiter.js";
import { isRateRefusal, pooledAccount, RpcPool } from "./rpc-pool.js";
import { rpcUsage } from "./rpc-usage.js";
import type { MpcSignature, VaultOperation } from "./types.js";

interface RpcResponse<T> {
  result?: T;
  error?: { message: string; data?: unknown };
}
class NearRpcApplicationError extends Error {}

/** The error part of a JSON-RPC answer, if any (a 200 can carry a rate refusal). */
function textOfError(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    return body.error ? JSON.stringify(body.error) : "";
  } catch {
    return "";
  }
}

/** The pool in order: NEAR_RPC_URL (paid), NEAR_RPC_URLS (comma separated), then NEAR_RPC_FALLBACK_URL. */
export function rpcEndpoints(env: { NEAR_RPC_URL: string; NEAR_RPC_URLS?: string | undefined; NEAR_RPC_FALLBACK_URL?: string | undefined }): string[] {
  return [env.NEAR_RPC_URL, ...(env.NEAR_RPC_URLS ?? "").split(",").map((url) => url.trim()).filter(Boolean), env.NEAR_RPC_FALLBACK_URL]
    .filter((url): url is string => Boolean(url));
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
  private readonly limiter: RpcLimiter;
  /** The endpoints, the paid one first: one that refuses for its rate or quota rests, the next one answers. */
  readonly pool: RpcPool;

  constructor(private readonly env: Pick<Env, "NEAR_NETWORK_ID" | "NEAR_RPC_URL" | "NEAR_RELAYER_ACCOUNT_ID" | "NEAR_RELAYER_PRIVATE_KEY"> & Partial<Pick<Env, "NEAR_RPC_CONCURRENCY" | "NEAR_RPC_MIN_INTERVAL_MS" | "NEAR_RPC_FALLBACK_URL" | "NEAR_RPC_URLS">>) {
    this.pool = new RpcPool(rpcEndpoints(env));
    this.accountPromise = pooledAccount(this.pool, env.NEAR_NETWORK_ID, env.NEAR_RELAYER_ACCOUNT_ID, env.NEAR_RELAYER_PRIVATE_KEY);
    // Several calls at once, paced, and screens before the background job (it used to be one call per 500 ms for everything).
    this.limiter = new RpcLimiter(env.NEAR_RPC_CONCURRENCY ?? 3, env.NEAR_RPC_MIN_INTERVAL_MS ?? 150);
    // What this process asks the RPC, logged once a minute (`near.rpc_usage`).
    rpcUsage.start();
  }

  /** The relayer account; its views and transactions go through the pool too. */
  private account(): Promise<Account> {
    return this.accountPromise;
  }

  private async requestRpc<T>(method: string, params: unknown): Promise<T> {
    const tried = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Another endpoint answers at once; when every one was tried, wait and start over.
      let url = this.pool.pick(tried);
      if (!url) {
        tried.clear();
        await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
        url = this.pool.pick()!;
      }
      tried.add(url);
      rpcUsage.record(this.pool.urls.indexOf(url), method, params);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "mandateos", method, params }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        // No answer: a read goes to the next endpoint; so does a broadcast (the same signed bytes, so at most once on chain).
        this.pool.rest(url, "down");
        if (attempt >= 4) throw error;
        continue;
      }
      const text = await response.text();
      const refusal = isRateRefusal(response.status, response.ok ? textOfError(text) : text);
      if (refusal) {
        this.pool.rest(url, refusal);
        continue;
      }
      if (response.status >= 500) {
        this.pool.rest(url, "down");
        continue;
      }
      if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
      const payload = JSON.parse(text) as RpcResponse<T>;
      if (payload.error) {
        throw new NearRpcApplicationError(
          `NEAR RPC ${payload.error.message}: ${JSON.stringify(payload.error.data ?? null)}`,
        );
      }
      if (payload.result === undefined) throw new Error("NEAR RPC response missing result");
      this.pool.ok(url);
      return payload.result;
    }
    throw new Error("NEAR RPC: every endpoint refused (rate, quota or no answer)");
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    return this.limiter.run(() => this.requestRpc<T>(method, params));
  }

  /**
   * The console's RPC proxy: reads share the server's pacing (one quota for every browser);
   * a broadcast goes straight through so it never holds a read slot while it waits.
   */
  async proxyRpc<T>(method: string, params: unknown): Promise<T> {
    if (/^(broadcast_tx|send_tx)/.test(method)) return this.requestRpc<T>(method, params);
    return this.rpc<T>(method, params);
  }


  private async callView<T>(accountId: string, methodName: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.rpc<{ result?: number[]; error?: string }>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: accountId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    // A method the contract does not have (an older vault version) comes back as `error`, not as a throw.
    // Callers branch on the message (e.g. "MethodResolveError" → "this vault cannot do it yet"), so it must survive.
    if (result.error) throw new Error(`${accountId}.${methodName}: ${result.error}`);
    if (!result.result) throw new Error(`${accountId}.${methodName}: no result`);
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
    const account = await this.account();
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
    const account = await this.account();
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
    const account = await this.account();
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

  /** The account that pays for companies, agents and members. */
  relayerAccountId(): string {
    return this.env.NEAR_RELAYER_ACCOUNT_ID;
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

  async settle(vaultAccountId: string, opId: number[], blockHash: Hex, cancellation = false): Promise<string> {
    return this.functionCall(vaultAccountId, cancellation ? "settle_cancellation" : "settle", { op_id: opId, block_hash: Array.from(hexToBytes(blockHash)) }, "70000000000000");
  }
  async settleSponsored(vaultAccountId: string, opId: number[], log: { txHash: Hex; blockHash: Hex; blockNumber: bigint; transactionIndex: number; logIndex: number }): Promise<string> {
    return this.functionCall(vaultAccountId, "settle_sponsored", {
      op_id: opId,
      tx_hash: Array.from(hexToBytes(log.txHash)),
      block_hash: Array.from(hexToBytes(log.blockHash)),
      block_number: log.blockNumber.toString(),
      tx_index: String(log.transactionIndex),
      log_index: String(log.logIndex),
    }, "70000000000000");
  }
  async delegateWallet(vaultAccountId: string, chainId: number): Promise<string> {
    return this.functionCall(vaultAccountId, "delegate_wallet", { chain_id: chainId }, "300000000000000");
  }
  async releaseUnconfirmed(vaultAccountId: string, opId: number[]): Promise<string> {
    return this.functionCall(vaultAccountId, "release_unconfirmed", { op_id: opId }, "30000000000000");
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

  async cancelNonce(vaultAccountId: string, opId: number[]): Promise<string> {
    return this.functionCall(vaultAccountId, "cancel_nonce", { op_id: opId }, "120000000000000");
  }

  /** Function call signed by the relayer (Euthyna pays gas and deposits). */
  async callFunction(
    contractId: string,
    methodName: string,
    args: Record<string, unknown>,
    gas: string,
    depositYocto: string,
  ): Promise<string> {
    const account = await this.account();
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
    const account = await this.account();
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

