import { Buffer } from "buffer";
import { KeyPair, Near, keyStores, transactions } from "near-api-js";
import { serializeNep413, setupWalletSelector, type SignedMessage, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import type { EIP1193Provider } from "viem";

import { api } from "./api.js";
import { demoWalletsEnabled, generatedNearWallet } from "./lib/wallet-store.js";

interface WalletAction {
  type: string;
  params?: Record<string, unknown>;
}

interface E2eNearWallet {
  getAccounts(): Promise<Array<{ accountId: string }>>;
  signAndSendTransaction(input: {
    signerId: string;
    receiverId: string;
    actions: WalletAction[];
  }): Promise<{ transaction_outcome: { id: string }; status?: { SuccessValue?: string } }>;
  signAndSendTransactions(input: {
    transactions: Array<{ signerId: string; receiverId: string; actions: WalletAction[] }>;
  }): Promise<Array<{ transaction_outcome: { id: string } }>>;
  signMessage?(input: {
    message: string;
    recipient: string;
    nonce: Buffer;
  }): Promise<SignedMessage>;
}

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
    __MANDATEOS_E2E_NEAR__?: E2eNearWallet;
  }
}

function e2eNear(): E2eNearWallet | undefined {
  return import.meta.env.VITE_E2E === "1" ? window.__MANDATEOS_E2E_NEAR__ : undefined;
}

async function generatedNear(): Promise<E2eNearWallet> {
  const wallet = generatedNearWallet();
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey("testnet", wallet.accountId, KeyPair.fromString(wallet.secretKey as `ed25519:${string}`));
  const near = new Near({
    networkId: "testnet",
    nodeUrl: `${window.location.origin}/near-rpc`,
    keyStore,
  });
  const account = await near.account(wallet.accountId);
  const map = (actions: WalletAction[]) => actions.map((action) => {
    const params = action.params ?? {};
    if (action.type === "CreateAccount") return transactions.createAccount();
    if (action.type === "Transfer") return transactions.transfer(BigInt(String(params.deposit ?? "0")));
    if (action.type === "DeployContract") return transactions.deployContract(params.code as Uint8Array);
    return transactions.functionCall(
      String(params.methodName ?? ""),
      (params.args ?? {}) as Record<string, unknown>,
      BigInt(String(params.gas ?? "0")),
      BigInt(String(params.deposit ?? "0")),
    );
  });
  return {
    signMessage: async ({ message, recipient, nonce }) => {
      const keyPair = KeyPair.fromString(wallet.secretKey as `ed25519:${string}`);
      const payload = serializeNep413({ message, recipient, nonce });
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(payload)));
      const signed = keyPair.sign(digest);
      return {
        accountId: wallet.accountId,
        publicKey: keyPair.getPublicKey().toString(),
        signature: Buffer.from(signed.signature).toString("base64"),
      };
    },
    getAccounts: async () => [{ accountId: wallet.accountId }],
    signAndSendTransaction: async ({ signerId, receiverId, actions }) => {
      if (signerId !== wallet.accountId) {
        throw new Error(`connected NEAR account is ${wallet.accountId}, expected ${signerId}`);
      }
      const outcome = await account.signAndSendTransaction({ receiverId, actions: map(actions) });
      return { transaction_outcome: { id: outcome.transaction_outcome.id } };
    },
    signAndSendTransactions: async ({ transactions: list }) => {
      const results: Array<{ transaction_outcome: { id: string } }> = [];
      for (const item of list) {
        if (item.signerId !== wallet.accountId) {
          throw new Error(`connected NEAR account is ${wallet.accountId}, expected ${item.signerId}`);
        }
        const outcome = await account.signAndSendTransaction({ receiverId: item.receiverId, actions: map(item.actions) });
        results.push({ transaction_outcome: { id: outcome.transaction_outcome.id } });
      }
      return results;
    },
  };
}

let selectorPromise: Promise<WalletSelector> | undefined;
let selectorModal: WalletSelectorModal | undefined;

export function nearSelector(): Promise<WalletSelector> {
  selectorPromise ??= setupWalletSelector({
    network: "testnet",
    modules: [setupMyNearWallet()],
  });
  return selectorPromise;
}

export async function connectNearWallet(): Promise<string[]> {
  const selector = await nearSelector();
  const accounts = selector.store.getState().accounts.map((account) => account.accountId);
  if (accounts.length === 0) {
    selectorModal ??= setupModal(selector, { contractId: "" });
    selectorModal.show();
  }
  return accounts;
}

export async function nearAccounts(): Promise<string[]> {
  const injected = e2eNear();
  if (injected) return (await injected.getAccounts()).map((account) => account.accountId);
  if (demoWalletsEnabled()) {
    return (await (await generatedNear()).getAccounts()).map((account) => account.accountId);
  }
  const selector = await nearSelector();
  return selector.store.getState().accounts.map((account) => account.accountId);
}
async function transactionWallet(): Promise<E2eNearWallet> {
  const injected = e2eNear();
  if (injected) return injected;
  if (demoWalletsEnabled()) return generatedNear();
  // Wallet Selector exposes the same transaction methods; the local interface also covers the E2E signer.
  return (await nearSelector()).wallet() as unknown as E2eNearWallet;
}

/** NEP-413 signature from the connected NEAR wallet (sign-in). */
export async function signNearMessage(input: { message: string; recipient: string; nonceBase64: string }): Promise<SignedMessage> {
  const params = { message: input.message, recipient: input.recipient, nonce: Buffer.from(input.nonceBase64, "base64") };
  const injected = e2eNear();
  const signed = injected?.signMessage
    ? await injected.signMessage(params)
    : demoWalletsEnabled()
      ? await (await generatedNear()).signMessage!(params)
      : await (await nearSelector()).wallet().then((wallet) => wallet.signMessage(params));
  if (!signed) throw new Error("The NEAR wallet did not return a signature");
  return signed;
}

const nearRpcPacingMs = import.meta.env.MODE === "test" ? 0 : 500;
const nearRpcRetryBaseMs = import.meta.env.MODE === "test" ? 0 : 1_000;
let nearRpcQueue: Promise<void> = Promise.resolve();
let nextNearRpcAt = 0;

async function nearRpcMethod<T>(method: string, params: unknown): Promise<T> {
  const previous = nearRpcQueue;
  let release!: () => void;
  nearRpcQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const pacingDelay = Math.max(0, nextNearRpcAt - Date.now());
    if (pacingDelay > 0) await new Promise((resolve) => setTimeout(resolve, pacingDelay));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await fetch(import.meta.env.VITE_NEAR_RPC_URL ?? "https://rpc.testnet.near.org", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "mandateos-browser", method, params }),
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 429 && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, nearRpcRetryBaseMs * (2 ** attempt)));
          continue;
        }
        if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
        const payload = await response.json() as { result?: T; error?: { message?: string } };
        if (payload.error) throw new Error(payload.error.message ?? `NEAR RPC ${method} failed`);
        if (payload.result === undefined) throw new Error("NEAR RPC result missing");
        return payload.result;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, nearRpcRetryBaseMs * (2 ** attempt)));
      }
    }
    throw new Error("NEAR RPC retry budget exhausted");
  } finally {
    nextNearRpcAt = Date.now() + nearRpcPacingMs;
    release();
  }
}

async function nearRpc<T>(params: Record<string, unknown>): Promise<T> {
  return nearRpcMethod<T>("query", { finality: "final", ...params });
}

export type AgentAccessKeyRpcAttestation = {
  valid: boolean;
  checks: Array<{ label: string; expected: string; actual: string; ok: boolean }>;
};

export async function readAgentAccessKeyRpc(input: {
  accountId: string;
  publicKey: string;
  vaultAccountId: string;
  methodNames: string[];
  allowanceYocto: null;
}): Promise<AgentAccessKeyRpcAttestation> {
  const result = await nearRpc<{ keys: unknown[] }>({
    request_type: "view_access_key_list",
    account_id: input.accountId,
  });
  const entry = result.keys.length === 1 && result.keys[0] && typeof result.keys[0] === "object"
    ? result.keys[0] as { public_key?: unknown; access_key?: { permission?: unknown } }
    : null;
  const permission = entry?.access_key?.permission;
  const functionCall = permission && typeof permission === "object" && "FunctionCall" in permission
    ? (permission as { FunctionCall?: { allowance?: unknown; receiver_id?: unknown; method_names?: unknown } }).FunctionCall
    : null;
  const methods = Array.isArray(functionCall?.method_names)
    ? functionCall.method_names.filter((value): value is string => typeof value === "string").sort()
    : [];
  const values: Array<[string, unknown, unknown]> = [
    ["Access key count", 1, result.keys.length],
    ["Public key", input.publicKey, entry?.public_key ?? null],
    ["Permission", "FunctionCall", functionCall ? "FunctionCall" : permission === "FullAccess" ? "FullAccess" : "unknown"],
    ["Receiver", input.vaultAccountId, functionCall?.receiver_id ?? null],
    ["Methods", JSON.stringify([...input.methodNames].sort()), JSON.stringify(methods)],
    ["Allowance", input.allowanceYocto, functionCall?.allowance ?? null],
  ];
  const checks = values.map(([label, expected, actual]) => ({
    label,
    expected: String(expected),
    actual: String(actual),
    ok: String(actual) === String(expected),
  }));
  return { valid: checks.every((check) => check.ok), checks };
}

function decodeProposalId(successValue: string | undefined): number | null {
  if (!successValue) return null;
  const value = JSON.parse(Buffer.from(successValue, "base64").toString("utf8")) as unknown;
  return Number.isInteger(value) ? Number(value) : null;
}

async function proposalIdFromTransaction(transactionHash: string, signerId: string): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const outcome = await nearRpcMethod<{ status?: { SuccessValue?: string } }>(
        "tx",
        [transactionHash, signerId],
      );
      const proposalId = decodeProposalId(outcome.status?.SuccessValue);
      if (proposalId !== null) return proposalId;
    } catch (cause) {
      if (attempt === 9) throw cause;
    }
    const wait = Promise.withResolvers<void>();
    setTimeout(wait.resolve, 1_000);
    await wait.promise;
  }
  throw new Error("DAO proposal id was not returned by NEAR RPC");
}

export async function signDaoProposal(
  signerId: string,
  proposal: { receiverId: string; args: Record<string, unknown>; deposit: string },
): Promise<{ transactionHash: string; proposalId: number }> {
  const wallet = await transactionWallet();
  const outcome = await wallet.signAndSendTransaction({
    signerId,
    receiverId: proposal.receiverId,
    actions: [{
      type: "FunctionCall",
      params: {
        methodName: "add_proposal",
        args: proposal.args,
        gas: "150000000000000",
        deposit: proposal.deposit,
      },
    }],
  });
  const transactionHash = outcome.transaction_outcome.id;
  const proposalId =
    decodeProposalId(outcome.status?.SuccessValue) ??
    await proposalIdFromTransaction(transactionHash, signerId);
  await refreshOmniReads();
  return { transactionHash, proposalId };
}

/** Sputnik prepays this much gas for a vote; members need about 0.3 NEAR. */
const DAO_VOTE_GAS = "200000000000000";

/** Approve or reject a DAO proposal from the connected member wallet. */
export async function signDaoAction(
  signerId: string,
  daoAccountId: string,
  proposalId: number,
  proposalKind: unknown,
  action: "VoteApprove" | "VoteReject",
): Promise<string> {
  const wallet = await transactionWallet();
  const outcome = await wallet.signAndSendTransaction({
    signerId,
    receiverId: daoAccountId,
    actions: [{
      type: "FunctionCall",
      params: {
        methodName: "act_proposal",
        args: { id: proposalId, action, proposal: proposalKind, memo: null },
        gas: DAO_VOTE_GAS,
        deposit: "0",
      },
    }],
  });
  await refreshOmniReads();
  return outcome.transaction_outcome.id;
}

/** Direct call on the vault by a council member (veto, emergency pause). */
export async function signVaultCall(
  signerId: string,
  vaultAccountId: string,
  methodName: "veto_rule_change" | "pause" | "veto_operation",
  args: Record<string, unknown>,
): Promise<string> {
  const wallet = await transactionWallet();
  const outcome = await wallet.signAndSendTransaction({
    signerId,
    receiverId: vaultAccountId,
    actions: [{
      type: "FunctionCall",
      params: { methodName, args, gas: "50000000000000", deposit: "0" },
    }],
  });
  await refreshOmniReads();
  return outcome.transaction_outcome.id;
}

/** The API caches NEAR reads; drop them after a member's own transaction so the page shows it at once. */
async function refreshOmniReads(): Promise<void> {
  await api("/v1/console/omniroles/refresh", { method: "POST", body: "{}" }).catch(() => undefined);
}
