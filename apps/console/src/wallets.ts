import { KeyPair, Near, keyStores, transactions } from "near-api-js";
import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { createPublicClient, createWalletClient, custom, http, type Address, type EIP1193Provider, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import type { NearAction, TreasuryPlan } from "./api.js";
import { demoWalletsEnabled, generatedEvmAccount, generatedNearWallet } from "./lib/wallet-store.js";

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
  }): Promise<{ transaction_outcome: { id: string } }>;
  signAndSendTransactions(input: {
    transactions: Array<{ signerId: string; receiverId: string; actions: WalletAction[] }>;
  }): Promise<Array<{ transaction_outcome: { id: string } }>>;
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
  const near = new Near({ networkId: "testnet", nodeUrl: "https://rpc.testnet.near.org", keyStore });
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

async function nearView<T>(accountId: string, methodName: string): Promise<T> {
  const response = await fetch(import.meta.env.VITE_NEAR_RPC_URL ?? "https://rpc.testnet.near.org", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "mandateos-browser",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: methodName,
        args_base64: "e30=",
      },
    }),
  });
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const payload = await response.json() as {
    result?: { result?: number[]; error?: string };
    error?: { message?: string };
  };
  if (payload.error) throw new Error(payload.error.message ?? "NEAR RPC query failed");
  if (payload.result?.error) throw new Error(payload.result.error);
  if (!payload.result?.result) throw new Error("NEAR RPC view result missing");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(payload.result.result))) as T;
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
  if (window.ethereum) {
    return createWalletClient({ chain: baseSepolia, transport: custom(window.ethereum) });
  }
  if (!demoWalletsEnabled()) {
    throw new Error("Install or unlock MetaMask/Rabby to sign Base Sepolia transactions");
  }
  return createWalletClient({
    account: generatedEvmAccount(),
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });
}

export async function evmAccounts(): Promise<Address[]> {
  if (window.ethereum) {
    return (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
  }
  if (!demoWalletsEnabled()) {
    throw new Error("Install or unlock MetaMask/Rabby to connect an EVM wallet");
  }
  return [generatedEvmAccount().address];
}

export async function switchToBaseSepolia(): Promise<void> {
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
  const account = window.ethereum
    ? (await evmAccounts())[0]
    : demoWalletsEnabled()
      ? generatedEvmAccount()
      : undefined;
  if (!account) throw new Error("No EVM account");
  return wallet.sendTransaction({
    account,
    to: transaction.to as Address,
    value: BigInt(transaction.value ?? "0"),
    data: transaction.data as Hex,
  });
}

export async function waitForEvmTransaction(hash: Hex): Promise<void> {
  const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
}


export async function signDaoProposal(
  signerId: string,
  proposal: { receiverId: string; args: Record<string, unknown>; deposit: string },
): Promise<string> {
  const injected = e2eNear();
  if (injected) {
    const outcome = await injected.signAndSendTransaction({
      signerId,
      receiverId: proposal.receiverId,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "add_proposal",
            args: proposal.args,
            gas: "150000000000000",
            deposit: proposal.deposit,
          },
        },
      ],
    });
    return outcome.transaction_outcome.id;
  }
  const generated = await generatedNear();
  const outcome = await generated.signAndSendTransaction({
    signerId,
    receiverId: proposal.receiverId,
    actions: [{ type: "FunctionCall", params: { methodName: "add_proposal", args: proposal.args, gas: "150000000000000", deposit: proposal.deposit } }],
  });
  return outcome.transaction_outcome.id;
}


export async function signDaoVote(signerId: string, daoAccountId: string, proposalId: number): Promise<string> {
  const injected = e2eNear();
  if (injected) {
    const outcome = await injected.signAndSendTransaction({
      signerId,
      receiverId: daoAccountId,
      actions: [
        {
          type: "FunctionCall",
          params: { methodName: "act_proposal", args: { id: proposalId, action: "VoteApprove" }, gas: "100000000000000", deposit: "0" },
        },
      ],
    });
    return outcome.transaction_outcome.id;
  }
  const generated = await generatedNear();
  const outcome = await generated.signAndSendTransaction({
    signerId,
    receiverId: daoAccountId,
    actions: [{ type: "FunctionCall", params: { methodName: "act_proposal", args: { id: proposalId, action: "VoteApprove" }, gas: "100000000000000", deposit: "0" } }],
  });
  return outcome.transaction_outcome.id;
}
