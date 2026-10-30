/**
 * NEAR side of the market: chain reads for cheque checks, and the dedicated
 * market relayer that pays the gas to relay held cheques. Its key never leaves
 * this process and is never logged.
 */
import { KeyPair, keyStores, Near, type Account } from "near-api-js";

import type { ChequeChain } from "./cheque.js";
import { relayAction } from "./cheque.js";

type Rpc = <T>(method: string, params: unknown) => Promise<T>;

export function chequeChain(rpc: Rpc): ChequeChain {
  return {
    async accessKey(accountId, publicKey) {
      try {
        const key = await rpc<{ nonce?: number | string; permission?: "FullAccess" | { FunctionCall: { receiver_id: string; method_names: string[] } }; error?: string }>(
          "query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
        );
        // Some nodes answer a missing key inside the result rather than as an RPC error.
        if (key.error !== undefined || key.nonce === undefined || key.permission === undefined) throw new Error(key.error ?? "malformed view_access_key answer");
        return { nonce: BigInt(key.nonce), permission: key.permission };
      } catch (error) {
        // A missing key or account is an answer; anything else is not.
        if (/does not exist|UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|AccessKeyDoesNotExist/i.test(String(error))) return null;
        throw error;
      }
    },
    async blockHeight() {
      const block = await rpc<{ header: { height: number } }>("block", { finality: "final" });
      return BigInt(block.header.height);
    },
    async ftBalance(token, accountId) {
      const result = await rpc<{ result: number[] }>("query", {
        request_type: "call_function", finality: "final", account_id: token, method_name: "ft_balance_of",
        args_base64: Buffer.from(JSON.stringify({ account_id: accountId })).toString("base64"),
      });
      return BigInt(JSON.parse(Buffer.from(result.result).toString("utf8")) as string);
    },
  };
}

/** Is `accountId` registered on the token (NEP-145)? An unregistered seller cannot be paid. */
export async function storageRegistered(rpc: Rpc, token: string, accountId: string): Promise<boolean> {
  const result = await rpc<{ result: number[] }>("query", {
    request_type: "call_function", finality: "final", account_id: token, method_name: "storage_balance_of",
    args_base64: Buffer.from(JSON.stringify({ account_id: accountId })).toString("base64"),
  });
  return JSON.parse(Buffer.from(result.result).toString("utf8")) !== null;
}

/** A final NEAR transaction as the gateway needs to check a direct payment. */
export type FinalTransaction = {
  signerId: string;
  receiverId: string;
  actions: Array<{ methodName: string; args: string; deposit: string }>;
  succeeded: boolean;
};

/** Reads a transaction at finality "FINAL"; null if unknown (or not final yet). */
export function finalTransaction(rpc: Rpc) {
  return async (txHash: string, senderId: string): Promise<FinalTransaction | null> => {
    let result: { transaction: { signer_id: string; receiver_id: string; actions: Array<Record<string, { method_name?: string; args?: string; deposit?: string }> | string> }; status: unknown; receipts_outcome: Array<{ outcome: { status: unknown } }>; final_execution_status?: string };
    try {
      result = await rpc("tx", { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" });
    } catch (error) {
      if (/UNKNOWN_TRANSACTION|doesn't exist|does not exist|TIMEOUT_ERROR/i.test(String(error))) return null;
      throw error;
    }
    const failed = [result.status, ...result.receipts_outcome.map((receipt) => receipt.outcome.status)].some((status) => status && typeof status === "object" && "Failure" in status);
    return {
      signerId: result.transaction.signer_id,
      receiverId: result.transaction.receiver_id,
      actions: result.transaction.actions.map((action) => {
        const call = typeof action === "object" ? action.FunctionCall : undefined;
        return { methodName: call?.method_name ?? (typeof action === "string" ? action : Object.keys(action)[0] ?? ""), args: call?.args ?? "", deposit: call?.deposit ?? "0" };
      }),
      succeeded: !failed,
    };
  };
}

export type RelayOutcome = { ok: true; txHash: string } | { ok: false; txHash: string | null; error: string };

export interface ChequeRelayer {
  readonly accountId: string;
  relay(signedDelegateB64: string, senderId: string): Promise<RelayOutcome>;
  balanceYocto(): Promise<bigint>;
}

type Outcome = {
  transaction_outcome: { id: string };
  status: unknown;
  receipts_outcome: Array<{ outcome: { status: unknown } }>;
};

/** Every receipt must succeed: the delegate itself, ft_transfer, and its refunds. */
export function outcomeError(outcome: Outcome): string | null {
  for (const status of [outcome.status, ...outcome.receipts_outcome.map((receipt) => receipt.outcome.status)]) {
    if (status && typeof status === "object" && "Failure" in status) return JSON.stringify((status as { Failure: unknown }).Failure).slice(0, 500);
  }
  return null;
}

export class NearChequeRelayer implements ChequeRelayer {
  private readonly account: Promise<Account>;

  constructor(readonly accountId: string, privateKey: string, networkId: string, nodeUrl: string) {
    const keyStore = new keyStores.InMemoryKeyStore();
    this.account = keyStore.setKey(networkId, accountId, KeyPair.fromString(privateKey as `ed25519:${string}`))
      .then(() => new Near({ networkId, nodeUrl, keyStore }).account(accountId));
  }

  async relay(signedDelegateB64: string, senderId: string): Promise<RelayOutcome> {
    try {
      const account = await this.account;
      const outcome = await account.signAndSendTransaction({ receiverId: senderId, actions: [relayAction(signedDelegateB64)] }) as unknown as Outcome;
      const error = outcomeError(outcome);
      return error ? { ok: false, txHash: outcome.transaction_outcome.id, error } : { ok: true, txHash: outcome.transaction_outcome.id };
    } catch (error) {
      // Thrown before or during inclusion (expired, nonce used, ...): no transfer happened.
      return { ok: false, txHash: null, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
  }

  async balanceYocto(): Promise<bigint> {
    const state = await (await this.account).state();
    return BigInt(state.amount);
  }
}
