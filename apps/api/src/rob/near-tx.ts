/**
 * Build, sign and send NEAR transactions for Rob the Agent, on plain JSON-RPC.
 *
 * Sent with `send_tx` (wait_until EXECUTED_OPTIMISTIC): about 3 seconds on
 * testnet, the receipts included.
 */
import { createHash } from "node:crypto";

import { KeyPair, transactions, utils } from "near-api-js";

export type RobAction =
  | { type: "FunctionCall"; methodName: string; args: Record<string, unknown>; gasTgas: number; depositYocto?: string }
  | { type: "Transfer"; depositYocto: string }
  | { type: "AddFullAccessKey"; publicKey: string }
  | { type: "AddFunctionCallKey"; publicKey: string; receiverId: string; methodNames: string[]; allowanceYocto: string }
  | { type: "DeleteKey"; publicKey: string };

export type Outcome =
  /** NEAR refused the transaction before the chain: no hash. */
  | { kind: "rejected"; error: string }
  | { kind: "failed"; tx: string; error: string; logs?: string[] }
  | { kind: "succeeded"; tx: string; value: string | null; logs?: string[] };

export class RpcError extends Error {
  constructor(readonly body: unknown) {
    super(typeof body === "string" ? body : JSON.stringify(body));
  }
}

export class NearRpc {
  constructor(private readonly url: string, private readonly fetcher: typeof fetch = fetch) {}

  async call<T>(method: string, params: unknown): Promise<T> {
    const response = await this.fetcher(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "rob", method, params }),
    });
    const body = (await response.json()) as { result?: T & { error?: unknown }; error?: unknown };
    if (body.error) throw new RpcError(body.error);
    if (body.result && typeof body.result === "object" && "error" in body.result && body.result.error) throw new RpcError(body.result.error);
    return body.result as T;
  }

  async view<T>(accountId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.call<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: accountId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    return JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
  }

  async accessKey(accountId: string, publicKey: string): Promise<{ nonce: number; block_hash: string } | null> {
    try {
      return await this.call("query", { request_type: "view_access_key", finality: "optimistic", account_id: accountId, public_key: publicKey });
    } catch (error) {
      if (/UNKNOWN_ACCESS_KEY|does not exist/i.test(String(error))) return null;
      throw error;
    }
  }

  private recentBlock: { hash: string; at: number } | null = null;

  /** A recent final block (a transaction stays valid for about a day after it): read at most every 30 s. */
  async finalBlockHash(): Promise<string> {
    if (this.recentBlock && Date.now() - this.recentBlock.at < 30_000) return this.recentBlock.hash;
    const block = await this.call<{ header: { hash: string } }>("block", { finality: "final" });
    this.recentBlock = { hash: block.header.hash, at: Date.now() };
    return block.header.hash;
  }

  /**
   * Send and wait for the receipts. NEAR answers an invalid transaction (a function-call key that
   * tries a Transfer or an AddKey) with InvalidTxError: refused before the chain, no hash.
   */
  async send(signedBase64: string, signerId: string): Promise<Outcome> {
    const tx = hashOfSigned(signedBase64);
    try {
      const result = await this.call<FinalOutcome>("send_tx", { signed_tx_base64: signedBase64, wait_until: "EXECUTED_OPTIMISTIC" });
      return outcomeOf(tx, result);
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      const text = JSON.stringify(error.body);
      if (/InvalidTxError|INVALID_TRANSACTION/.test(text)) return { kind: "rejected", error: rejectionReason(error.body) };
      if (/TIMEOUT_ERROR/.test(text)) return this.outcome(tx, signerId);
      throw error;
    }
  }

  /** The outcome of a sent transaction, once its receipts ran. */
  async outcome(tx: string, signerId: string, timeoutMs = 20_000): Promise<Outcome> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const result = await this.call<FinalOutcome>("tx", { tx_hash: tx, sender_account_id: signerId, wait_until: "EXECUTED_OPTIMISTIC" });
        return outcomeOf(tx, result);
      } catch (error) {
        if (Date.now() > deadline) throw error;
        if (!/UNKNOWN_TRANSACTION|TIMEOUT_ERROR|does not exist/i.test(String(error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
}

type FinalOutcome = {
  status: { SuccessValue?: string; Failure?: unknown };
  receipts_outcome: Array<{ outcome: { status: { Failure?: unknown; SuccessValue?: string }; logs?: string[] } }>;
};

export function hashOfSigned(signedBase64: string): string {
  const signed = transactions.SignedTransaction.decode(Buffer.from(signedBase64, "base64"));
  return utils.serialize.base_encode(createHash("sha256").update(transactions.encodeTransaction(signed.transaction)).digest());
}

/** The panic message of the first failed receipt, e.g. "ERR_OWNER_ONLY". */
export function outcomeOf(tx: string, result: FinalOutcome): Outcome {
  const failures = [result.status.Failure, ...result.receipts_outcome.map((receipt) => receipt.outcome.status.Failure)].filter(Boolean);
  const logs = result.receipts_outcome.flatMap((receipt) => receipt.outcome.logs ?? []);
  if (failures.length === 0) {
    const value = result.status.SuccessValue ? Buffer.from(result.status.SuccessValue, "base64").toString("utf8") : null;
    return { kind: "succeeded", tx, value, logs };
  }
  return { kind: "failed", tx, error: failureReason(failures[0]), logs };
}

export function failureReason(failure: unknown): string {
  const text = JSON.stringify(failure);
  // Sputnik panics as "panicked at 'ERR_PERMISSION_DENIED', src/…": keep the code.
  const code = /panicked(?: at '|: )(ERR_[A-Za-z0-9_:]+)/.exec(text);
  if (code) return code[1]!;
  const panic = /Smart contract panicked: ([^"\\]+)/.exec(text);
  if (panic) return panic[1]!.trim();
  const execution = /"ExecutionError":"([^"]+)"/.exec(text);
  if (execution) return execution[1]!;
  const kind = /"([A-Z][A-Za-z]+)":/.exec(text.replace(/^\{"ActionError":\{"index":\d+,"kind":/, ""));
  return kind?.[1] ?? text.slice(0, 200);
}

/** Why NEAR refused a transaction before the chain, e.g. "RequiresFullAccess". */
export function rejectionReason(body: unknown): string {
  const text = JSON.stringify(body);
  for (const known of ["RequiresFullAccess", "ReceiverMismatch", "MethodNameMismatch", "DepositWithFunctionCall", "NotEnoughAllowance", "AccessKeyNotFound", "InvalidNonce", "NotEnoughBalance", "Expired", "InvalidSignature"]) {
    if (text.includes(known)) return known;
  }
  return text.slice(0, 200);
}

export function nearAction(action: RobAction): transactions.Action {
  switch (action.type) {
    case "FunctionCall":
      return transactions.functionCall(action.methodName, action.args, BigInt(action.gasTgas) * 1_000_000_000_000n, BigInt(action.depositYocto ?? "0"));
    case "Transfer":
      return transactions.transfer(BigInt(action.depositYocto));
    case "AddFullAccessKey":
      return transactions.addKey(utils.PublicKey.fromString(action.publicKey), transactions.fullAccessKey());
    case "AddFunctionCallKey":
      return transactions.addKey(
        utils.PublicKey.fromString(action.publicKey),
        transactions.functionCallAccessKey(action.receiverId, action.methodNames, BigInt(action.allowanceYocto)),
      );
    case "DeleteKey":
      return transactions.deleteKey(utils.PublicKey.fromString(action.publicKey));
  }
}

/** An unsigned transaction and the 32-byte hash its signer signs. */
export function buildTransaction(input: { signerId: string; publicKey: string; receiverId: string; nonce: number | bigint; blockHash: string; actions: RobAction[] }) {
  const transaction = transactions.createTransaction(
    input.signerId,
    utils.PublicKey.fromString(input.publicKey),
    input.receiverId,
    BigInt(input.nonce),
    input.actions.map(nearAction),
    utils.serialize.base_decode(input.blockHash),
  );
  const bytes = transactions.encodeTransaction(transaction);
  return { transaction, bytes, hash: createHash("sha256").update(bytes).digest() };
}

/** Attach a signature over the hash: the signed transaction, base64. */
export function attachSignature(transaction: transactions.Transaction, signature: Uint8Array): string {
  const signed = new transactions.SignedTransaction({
    transaction,
    signature: new transactions.Signature({ keyType: transaction.publicKey.keyType, data: signature }),
  });
  return Buffer.from(signed.encode()).toString("base64");
}

export function signWith(secretKey: string, transaction: transactions.Transaction, hash: Uint8Array): string {
  const keyPair = KeyPair.fromString(secretKey as Parameters<typeof KeyPair.fromString>[0]);
  return attachSignature(transaction, keyPair.sign(hash).signature);
}
