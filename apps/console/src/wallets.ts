import { Buffer } from "buffer";
import { KeyPair, Near, keyStores, transactions } from "near-api-js";
import { serializeNep413, setupWalletSelector, type SignedMessage, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { createPublicClient, createWalletClient, custom, encodeFunctionData, getAddress, http, type Address, type EIP1193Provider, type Hex } from "viem";
import { baseSepolia, sepolia } from "viem/chains";

import type { BudgetTokenPlan, NearAction, TreasuryPlan } from "./api.js";
import { demoWalletsEnabled, generatedEvmAccount, generatedNearWallet, selectDemoWalletScopeForAccounts } from "./lib/wallet-store.js";
export const DAO_VOTE_GAS = "200000000000000";


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


export type WalletProofChallenge = {
  id: string;
  memberId: string;
  nearAccountId: string;
  evmAddress: string;
  message: string;
  nonceBase64: string;
  recipient: string;
  expiresAt: string;
};

export async function signWalletProofChallenge(challenge: WalletProofChallenge): Promise<{
  challengeId: string;
  nearAccountId: string;
  nearPublicKey: string;
  nearSignature: string;
  evmAddress: string;
  evmSignature: Hex;
}> {
  if (
    demoWalletsEnabled() &&
    !selectDemoWalletScopeForAccounts(challenge.nearAccountId, challenge.evmAddress)
  ) {
    throw new Error("No generated demo wallet matches the declared member accounts");
  }
  const nonce = Buffer.from(challenge.nonceBase64, "base64");
  const params = { message: challenge.message, recipient: challenge.recipient, nonce };
  const injected = e2eNear();
  const nearSigned = injected?.signMessage
    ? await injected.signMessage(params)
    : demoWalletsEnabled()
      ? await (await generatedNear()).signMessage!(params)
      : await (await nearSelector()).wallet().then((wallet) => wallet.signMessage(params));
  if (!nearSigned) throw new Error("NEAR wallet did not return a NEP-413 signature");
  if (nearSigned.accountId !== challenge.nearAccountId) {
    throw new Error(`NEAR signer ${nearSigned.accountId} does not match ${challenge.nearAccountId}`);
  }

  await switchToBaseSepolia();
  const evmAddress = getAddress((await evmAccounts())[0] ?? "");
  if (evmAddress !== getAddress(challenge.evmAddress)) {
    throw new Error(`EVM signer ${evmAddress} does not match ${challenge.evmAddress}`);
  }
  const evmSignature = await evmWalletClient().signMessage({
    account: demoWalletsEnabled() ? generatedEvmAccount() : evmAddress,
    message: challenge.message,
  });
  return {
    challengeId: challenge.id,
    nearAccountId: nearSigned.accountId,
    nearPublicKey: nearSigned.publicKey,
    nearSignature: nearSigned.signature,
    evmAddress,
    evmSignature,
  };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function selectorActions(actions: NearAction[]) {
  return actions.map((action) => {
    if (action.type === "CreateAccount") return { type: "CreateAccount" as const };
    if (action.type === "Transfer") {
      return { type: "Transfer" as const, params: { deposit: action.depositYocto } };
    }
    if (action.type === "DeployContract") {
      return {
        type: "DeployContract" as const,
        params: { code: base64ToBytes(action.codeBase64) },
      };
    }
    return {
      type: "FunctionCall" as const,
      params: {
        methodName: action.methodName,
        args: action.args,
        gas: String(action.gasTgas * 1_000_000_000_000),
        deposit: "0",
      },
    };
  });
}

export async function signNearTransactions(
  signerId: string,
  transactions: Array<{ receiverId: string; actions: NearAction[] }>,
): Promise<string[]> {
  const injected = e2eNear();
  if (injected) {
    const outcomes = await injected.signAndSendTransactions({
      transactions: transactions.map((transaction) => ({
        signerId,
        receiverId: transaction.receiverId,
        actions: selectorActions(transaction.actions),
      })),
    });
    return outcomes.map((outcome) => outcome.transaction_outcome.id);
  }
  if (demoWalletsEnabled()) {
    const generated = await generatedNear();
    const outcomes = await generated.signAndSendTransactions({
      transactions: transactions.map((transaction) => ({
        signerId,
        receiverId: transaction.receiverId,
        actions: selectorActions(transaction.actions),
      })),
    });
    return outcomes.map((outcome) => outcome.transaction_outcome.id);
  }
  const wallet = await (await nearSelector()).wallet();
  const outcomes = await wallet.signAndSendTransactions({
    transactions: transactions.map((transaction) => ({
      signerId,
      receiverId: transaction.receiverId,
      actions: selectorActions(transaction.actions),
    })),
  });
  return outcomes?.map((outcome) => outcome.transaction_outcome.id) ?? [];
}

export async function createDao(plan: TreasuryPlan, signerId: string): Promise<string[]> {
  const injected = e2eNear();
  if (injected) {
    const outcome = await injected.signAndSendTransaction({
      signerId,
      receiverId: plan.daoCreate.factoryId,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "create",
            args: plan.daoCreate.args,
            gas: "150000000000000",
            deposit: plan.daoCreate.depositYocto,
          },
        },
      ],
    });
    return [outcome.transaction_outcome.id];
  }
  const action = {
    type: "FunctionCall" as const,
    params: {
      methodName: "create",
      args: plan.daoCreate.args,
      gas: "150000000000000",
      deposit: plan.daoCreate.depositYocto,
    },
  };
  if (demoWalletsEnabled()) {
    const outcome = await (await generatedNear()).signAndSendTransaction({
      signerId,
      receiverId: plan.daoCreate.factoryId,
      actions: [action],
    });
    return [outcome.transaction_outcome.id];
  }
  const wallet = await (await nearSelector()).wallet();
  const outcome = await wallet.signAndSendTransaction({
    signerId,
    receiverId: plan.daoCreate.factoryId,
    actions: [action],
  });
  return outcome ? [outcome.transaction_outcome.id] : [];
}

export type DaoPolicyRpc = {
  council: string[];
  threshold: string;
  autoUpdate: boolean | null;
  factoryId: string | null;
};

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

async function nearView<T>(
  accountId: string,
  methodName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await nearRpc<{ result?: number[]; error?: string }>({
    request_type: "call_function",
    account_id: accountId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (result.error) throw new Error(result.error);
  if (!result.result) throw new Error("NEAR RPC view result missing");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result))) as T;
}

export type DaoProposalRpcState = "Not proposed" | "In progress" | "Executed" | "Failed" | "Expired";

export type DaoProposalRpc = {
  id: number;
  description: string;
  state: DaoProposalRpcState;
  rawStatus: string;
  kind: unknown;
};

function proposalState(status: string): DaoProposalRpcState {
  if (status === "Approved") return "Executed";
  if (status === "Expired") return "Expired";
  if (status === "InProgress") return "In progress";
  return "Failed";
}

export async function readDaoProposalRpc(daoAccountId: string, proposalId: number): Promise<DaoProposalRpc> {
  const proposal = await nearView<{ id: number; description: string; status: string; kind: unknown }>(
    daoAccountId,
    "get_proposal",
    { id: proposalId },
  );
  return {
    id: proposal.id,
    description: proposal.description,
    state: proposalState(proposal.status),
    rawStatus: proposal.status,
    kind: proposal.kind,
  };
}

export async function findDaoProposalsRpc(
  daoAccountId: string,
  descriptions: string[],
): Promise<Record<string, DaoProposalRpc>> {
  const lastProposalId = await nearView<number>(daoAccountId, "get_last_proposal_id");
  const proposals = await nearView<Array<{ id: number; description: string; status: string; kind: unknown }>>(
    daoAccountId,
    "get_proposals",
    { from_index: Math.max(0, lastProposalId - 100), limit: 100 },
  );
  const expected = new Set(descriptions);
  const matches: Record<string, DaoProposalRpc> = {};
  for (const proposal of proposals) {
    if (!expected.has(proposal.description)) continue;
    matches[proposal.description] = {
      id: proposal.id,
      description: proposal.description,
      state: proposalState(proposal.status),
      rawStatus: proposal.status,
      kind: proposal.kind,
    };
  }
  return matches;
}

export async function findDaoProposalRpc(
  daoAccountId: string,
  description: string,
): Promise<DaoProposalRpc | null> {
  const proposals = await findDaoProposalsRpc(daoAccountId, [description]);
  return proposals[description] ?? null;
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

export async function readDaoPolicyRpc(daoAccountId: string): Promise<DaoPolicyRpc> {
  const policy = await nearView<{
    roles?: Array<{ name?: string; kind?: { Group?: string[] } }>;
    default_vote_policy?: { threshold?: string | number };
  }>(daoAccountId, "get_policy");
  const councilRole = policy.roles?.find((role) => role.name === "council");
  const council = councilRole?.kind?.Group;
  if (!Array.isArray(council)) throw new Error("DAO council role missing from get_policy");
  const threshold = policy.default_vote_policy?.threshold;
  if (threshold === undefined) throw new Error("DAO threshold missing from get_policy");

  let factoryInfo: { factory_id?: string; auto_update?: boolean } | null = null;
  try {
    factoryInfo = await nearView(daoAccountId, "get_factory_info");
  } catch {
    // Older Sputnik builds may not expose this view. Policy verification remains valid.
  }
  return {
    council: [...council].sort(),
    threshold: String(threshold),
    autoUpdate: factoryInfo?.auto_update ?? null,
    factoryId: factoryInfo?.factory_id ?? null,
  };
}

export type NearDeploymentRpcCheck = {
  label: string;
  expected: string;
  actual: string;
  ok: boolean;
};

export type NearDeploymentRpcAttestation = {
  valid: boolean;
  checks: NearDeploymentRpcCheck[];
};

function base58Encode(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index]! * 256;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let encoded = "";
  for (let index = 0; index < bytes.length - 1 && bytes[index] === 0; index += 1) encoded += "1";
  for (let index = digits.length - 1; index >= 0; index -= 1) encoded += alphabet[digits[index]!]!;
  return encoded;
}

function expectedCodeHash(sha256Hex: string): string {
  return base58Encode(Uint8Array.from(sha256Hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16)));
}

export async function readNearDeploymentRpc(plan: TreasuryPlan): Promise<NearDeploymentRpcAttestation> {
  const [
    vaultAccount,
    vaultKeys,
    relayAccount,
    relayKeys,
    vaultOwner,
    vaultMpc,
    vaultChain,
    vaultToken,
    vaultGuard,
    vaultTtl,
    relayClient,
    relayOwner,
    relayMpc,
    relayPath,
    relayChain,
    relayDelay,
    relayMultiSend,
    relayGuard,
  ] = await Promise.all([
    nearRpc<{ code_hash: string }>({ request_type: "view_account", account_id: plan.vault.accountId }),
    nearRpc<{ keys: unknown[] }>({ request_type: "view_access_key_list", account_id: plan.vault.accountId }),
    nearRpc<{ code_hash: string }>({ request_type: "view_account", account_id: plan.relay.accountId }),
    nearRpc<{ keys: unknown[] }>({ request_type: "view_access_key_list", account_id: plan.relay.accountId }),
    nearView<string>(plan.vault.accountId, "owner_id"),
    nearView<string>(plan.vault.accountId, "mpc_contract_id"),
    nearView<number>(plan.vault.accountId, "evm_chain_id"),
    nearView<string>(plan.vault.accountId, "token_id"),
    nearView<string>(plan.vault.accountId, "guard_public_key"),
    nearView<number>(plan.vault.accountId, "reservation_ttl_blocks"),
    nearView<string>(plan.relay.accountId, "client_id"),
    nearView<string>(plan.relay.accountId, "owner_id"),
    nearView<string>(plan.relay.accountId, "mpc_contract_id"),
    nearView<string>(plan.relay.accountId, "mpc_path"),
    nearView<number>(plan.relay.accountId, "evm_chain_id"),
    nearView<string>(plan.relay.accountId, "delay_address"),
    nearView<string>(plan.relay.accountId, "multisend_address"),
    nearView<string>(plan.relay.accountId, "guard_public_key"),
  ]);
  const values: Array<[string, unknown, unknown]> = [
    ["Vault has no access key", 0, vaultKeys.keys.length],
    ["Vault code hash", expectedCodeHash(plan.vault.wasmSha256), vaultAccount.code_hash],
    ["Vault owner_id", plan.daoAccountId, vaultOwner],
    ["Vault mpc_contract_id", plan.vault.initArgs.mpc_contract_id, vaultMpc],
    ["Vault evm_chain_id", plan.vault.initArgs.evm_chain_id, vaultChain],
    ["Vault token_id", plan.vault.initArgs.token_id, vaultToken],
    ["Vault guard_public_key", plan.vault.initArgs.guard_public_key, vaultGuard],
    ["Vault reservation_ttl_blocks", plan.vault.initArgs.reservation_ttl_blocks, vaultTtl],
    ["Relay has no access key", 0, relayKeys.keys.length],
    ["Relay code hash", expectedCodeHash(plan.relay.wasmSha256), relayAccount.code_hash],
    ["Relay owner_id", plan.daoAccountId, relayOwner],
    ["Relay client_id", plan.relay.initArgs.client_id, relayClient],
    ["Relay mpc_contract_id", plan.relay.initArgs.mpc_contract_id, relayMpc],
    ["Relay mpc_path", plan.relay.initArgs.mpc_path, relayPath],
    ["Relay evm_chain_id", plan.relay.initArgs.evm_chain_id, relayChain],
    ["Relay delay_address", plan.relay.initArgs.delay_address, relayDelay],
    ["Relay multisend_address", plan.relay.initArgs.multisend_address, relayMultiSend],
    ["Relay guard_public_key", plan.relay.initArgs.guard_public_key, relayGuard],
  ];
  const checks = values.map(([label, expected, actual]) => ({
    label,
    expected: String(expected),
    actual: String(actual),
    ok: String(actual) === String(expected),
  }));
  return { valid: checks.every((check) => check.ok), checks };
}

export async function disableFactoryAutoUpdate(
  plan: TreasuryPlan,
  signerId: string,
): Promise<string[]> {
  const injected = e2eNear();
  if (injected) {
    const args = {
      proposal: {
        description: "Disable Sputnik factory auto-update",
        kind: {
          FactoryInfoUpdate: {
            factory_info: { factory_id: plan.daoCreate.factoryId, auto_update: false },
          },
        },
      },
    };
    const outcome = await injected.signAndSendTransaction({
      signerId,
      receiverId: plan.daoAccountId,
      actions: [
        {
          type: "FunctionCall",
          params: { methodName: "add_proposal", args, gas: "100000000000000", deposit: "100000000000000000000000" },
        },
      ],
    });
    return [outcome.transaction_outcome.id];
  }
  const args = { proposal: { description: "Disable Sputnik factory auto-update", kind: { FactoryInfoUpdate: { factory_info: { factory_id: plan.daoCreate.factoryId, auto_update: false } } } } };
  const action = { type: "FunctionCall" as const, params: { methodName: "add_proposal", args, gas: "100000000000000", deposit: "100000000000000000000000" } };
  if (demoWalletsEnabled()) {
    const outcome = await (await generatedNear()).signAndSendTransaction({
      signerId,
      receiverId: plan.daoAccountId,
      actions: [action],
    });
    return [outcome.transaction_outcome.id];
  }
  const wallet = await (await nearSelector()).wallet();
  const outcome = await wallet.signAndSendTransaction({
    signerId,
    receiverId: plan.daoAccountId,
    actions: [action],
  });
  return outcome ? [outcome.transaction_outcome.id] : [];
}

export function evmWalletClient() {
  if (demoWalletsEnabled()) {
    return createWalletClient({
      account: generatedEvmAccount(),
      chain: baseSepolia,
      transport: http("https://sepolia.base.org"),
    });
  }
  if (!window.ethereum) {
    throw new Error("Install or unlock MetaMask/Rabby to sign Base Sepolia transactions");
  }
  return createWalletClient({ chain: baseSepolia, transport: custom(window.ethereum) });
}

function parseEvmAccounts(value: unknown): Address[] {
  if (!Array.isArray(value) || value.some((address) => typeof address !== "string")) {
    throw new Error("EVM wallet returned an invalid account list");
  }
  return value.map((address) => getAddress(address));
}

export async function evmConnectedAccounts(): Promise<Address[]> {
  if (demoWalletsEnabled()) return [generatedEvmAccount().address];
  if (!window.ethereum) return [];
  return parseEvmAccounts(await window.ethereum.request({ method: "eth_accounts" }));
}

export async function evmAccounts(): Promise<Address[]> {
  if (demoWalletsEnabled()) return [generatedEvmAccount().address];
  if (!window.ethereum) {
    throw new Error("Install or unlock MetaMask/Rabby to connect an EVM wallet");
  }
  return parseEvmAccounts(await window.ethereum.request({ method: "eth_requestAccounts" }));
}

export async function switchToBaseSepolia(): Promise<void> {
  if (demoWalletsEnabled()) return;
  if (window.ethereum) {
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14a34" }] });
    } catch {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: "0x14a34", chainName: "Base Sepolia", nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://sepolia.base.org"], blockExplorerUrls: ["https://sepolia.basescan.org"] }],
      });
    }
  }
}

export async function sendEvmTransaction(transaction: { to: string; value: string; data: string }): Promise<Hex> {
  await switchToBaseSepolia();
  const wallet = evmWalletClient();
  const account = demoWalletsEnabled()
    ? generatedEvmAccount()
    : (await evmAccounts())[0];
  if (!account) throw new Error("No EVM account");
  return wallet.sendTransaction({
    account,
    to: transaction.to as Address,
    value: BigInt(transaction.value ?? "0"),
    data: transaction.data as Hex,
  });
}

const l1StandardBridgeAbi = [{
  type: "function",
  name: "depositETH",
  stateMutability: "payable",
  inputs: [
    { name: "_minGasLimit", type: "uint32" },
    { name: "_extraData", type: "bytes" },
  ],
  outputs: [],
}] as const;
const BASE_SEPOLIA_L1_STANDARD_BRIDGE = getAddress("0xfd0Bf71F60660E2f608ed56e1659C450eB113120");

export async function bridgeSepoliaEthToBase(amountWei: bigint): Promise<Hex> {
  if (!demoWalletsEnabled()) throw new Error("UAT demo wallet mode is required for the built-in testnet bridge");
  const account = generatedEvmAccount();
  const transport = http("https://ethereum-sepolia-rpc.publicnode.com");
  const wallet = createWalletClient({ account, chain: sepolia, transport });
  const hash = await wallet.sendTransaction({
    account,
    to: BASE_SEPOLIA_L1_STANDARD_BRIDGE,
    value: amountWei,
    data: encodeFunctionData({
      abi: l1StandardBridgeAbi,
      functionName: "depositETH",
      args: [200_000, "0x"],
    }),
  });
  await createPublicClient({ chain: sepolia, transport }).waitForTransactionReceipt({ hash });
  return hash;
}

export async function readBaseDeploymentRpc(plan: TreasuryPlan): Promise<boolean> {
  const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
  const codes = await Promise.all([
    plan.base.safeAddress,
    plan.base.rolesAddress,
    plan.base.delayAddress,
  ].map((address) => client.getBytecode({ address: getAddress(address) })));
  return codes.every((code) => code !== undefined && code !== "0x");
}

export async function waitForEvmTransaction(hash: Hex): Promise<void> {
  const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
}


export async function signNearFunctionCalls(
  signerId: string,
  calls: BudgetTokenPlan["actions"],
): Promise<string[]> {
  const wallet = await transactionWallet();
  const hashes: string[] = [];
  for (const call of calls) {
    const outcome = await wallet.signAndSendTransaction({
      signerId,
      receiverId: call.receiverId,
      actions: [{
        type: "FunctionCall",
        params: {
          methodName: call.methodName,
          args: call.args,
          gas: call.gas,
          deposit: call.deposit,
        },
      }],
    });
    hashes.push(outcome.transaction_outcome.id);
  }
  return hashes;
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
  return { transactionHash, proposalId };
}

export function daoVoteArgs(proposalId: number, proposalKind: unknown) {
  return {
    id: proposalId,
    action: "VoteApprove",
    proposal: proposalKind,
    memo: null,
  };
}

export async function signDaoVote(
  signerId: string,
  daoAccountId: string,
  proposalId: number,
  proposalKind: unknown,
): Promise<string> {
  const wallet = await transactionWallet();
  const outcome = await wallet.signAndSendTransaction({
    signerId,
    receiverId: daoAccountId,
    actions: [{
      type: "FunctionCall",
      params: {
        methodName: "act_proposal",
        args: daoVoteArgs(proposalId, proposalKind),
        gas: DAO_VOTE_GAS,
        deposit: "0",
      },
    }],
  });
  return outcome.transaction_outcome.id;
}

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
  return outcome.transaction_outcome.id;
}
