import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { createPublicClient, createWalletClient, custom, http, type Address, type EIP1193Provider, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

import type { NearAction, TreasuryPlan } from "./api.js";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

let selectorPromise: Promise<WalletSelector> | undefined;

export function nearSelector(): Promise<WalletSelector> {
  selectorPromise ??= setupWalletSelector({
    network: "testnet",
    modules: [setupMyNearWallet()],
  });
  return selectorPromise;
}

export async function nearAccounts(): Promise<string[]> {
  const selector = await nearSelector();
  const wallet = await selector.wallet();
  const accounts = await wallet.getAccounts();
  return accounts.map((account) => account.accountId);
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
  const selector = await nearSelector();
  const wallet = await selector.wallet();
  const outcomes = await wallet.signAndSendTransactions({
    transactions: transactions.map((transaction) => ({
      signerId,
      receiverId: transaction.receiverId,
      actions: selectorActions(transaction.actions),
    })),
  });
  if (!outcomes) throw new Error("wallet returned no transaction outcome");
  return outcomes.map((outcome) => outcome.transaction_outcome.id);
}

export async function createDao(plan: TreasuryPlan, signerId: string): Promise<string[]> {
  const selector = await nearSelector();
  const wallet = await selector.wallet();
  const outcome = await wallet.signAndSendTransaction({
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
  if (!outcome) throw new Error("wallet returned no transaction outcome");
  return [outcome.transaction_outcome.id];
}

export async function disableFactoryAutoUpdate(
  plan: TreasuryPlan,
  signerId: string,
): Promise<string[]> {
  const selector = await nearSelector();
  const wallet = await selector.wallet();
  const outcome = await wallet.signAndSendTransaction({
    signerId,
    receiverId: plan.daoAccountId,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "add_proposal",
          args: {
            proposal: {
              description: "Disable Sputnik factory auto-update",
              kind: {
                FactoryInfoUpdate: {
                  factory_info: { factory_id: plan.daoCreate.factoryId, auto_update: false },
                },
              },
            },
          },
          gas: "100000000000000",
          deposit: "100000000000000000000000",
        },
      },
    ],
  });
  if (!outcome) throw new Error("wallet returned no transaction outcome");
  return [outcome.transaction_outcome.id];
}

export function evmWalletClient() {
  if (!window.ethereum) throw new Error("No EVM wallet found");
  return createWalletClient({
    chain: baseSepolia,
    transport: custom(window.ethereum),
  });
}

export async function evmAccounts(): Promise<Address[]> {
  if (!window.ethereum) throw new Error("No EVM wallet found");
  const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
  return accounts;
}

export async function switchToBaseSepolia(): Promise<void> {
  if (!window.ethereum) throw new Error("No EVM wallet found");
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14a34" }] });
  } catch {
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: "0x14a34",
          chainName: "Base Sepolia",
          nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://sepolia.base.org"],
          blockExplorerUrls: ["https://sepolia.basescan.org"],
        },
      ],
    });
  }
}

export async function sendEvmTransaction(transaction: { to: string; value: string; data: string }): Promise<Hex> {
  await switchToBaseSepolia();
  const [account] = await evmAccounts();
  if (!account) throw new Error("No EVM account selected");
  const wallet = evmWalletClient();
  return wallet.sendTransaction({
    account,
    to: transaction.to as Address,
    value: BigInt(transaction.value),
    data: transaction.data as Hex,
  });
}

export async function waitForEvmTransaction(hash: Hex): Promise<void> {
  const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
}
