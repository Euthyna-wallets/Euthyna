/**
 * TEST-ONLY signers injected by the Playwright harness.
 * Never bundled in a production build (guarded by VITE_E2E and checked by
 * src/prod-build.test.ts).
 */
import { KeyPair, Near, keyStores, transactions } from "near-api-js";
import { createPublicClient, createWalletClient, http, type Address, type EIP1193Provider, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export const E2E_SIGNERS_MARKER = "MANDATEOS_E2E_SIGNERS_V1";

interface SelectorAction {
  type: string;
  params?: Record<string, unknown>;
}

interface E2eNearWallet {
  getAccounts(): Promise<Array<{ accountId: string }>>;
  signAndSendTransaction(input: {
    signerId: string;
    receiverId: string;
    actions: SelectorAction[];
  }): Promise<{ transaction_outcome: { id: string } }>;
  signAndSendTransactions(input: {
    transactions: Array<{ signerId: string; receiverId: string; actions: SelectorAction[] }>;
  }): Promise<Array<{ transaction_outcome: { id: string } }>>;
}

function nearActions(actions: SelectorAction[]) {
  return actions.map((action) => {
    const params = action.params ?? {};
    switch (action.type) {
      case "CreateAccount":
        return transactions.createAccount();
      case "Transfer":
        return transactions.transfer(BigInt(String(params.deposit)));
      case "DeployContract":
        return transactions.deployContract(params.code as Uint8Array);
      case "FunctionCall":
        return transactions.functionCall(
          String(params.methodName),
          (params.args ?? {}) as Record<string, unknown>,
          BigInt(String(params.gas)),
          BigInt(String(params.deposit ?? "0")),
        );
      default:
        throw new Error(`unsupported NEAR action ${action.type}`);
    }
  });
}

async function installNearSigner(): Promise<void> {
  const accountId = import.meta.env.VITE_E2E_NEAR_ACCOUNT_ID;
  const privateKey = import.meta.env.VITE_E2E_NEAR_PRIVATE_KEY;
  const rpcUrl = import.meta.env.VITE_E2E_NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
  if (!accountId || !privateKey) {
    throw new Error("VITE_E2E_NEAR_ACCOUNT_ID / VITE_E2E_NEAR_PRIVATE_KEY are required");
  }
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey("testnet", accountId, KeyPair.fromString(privateKey));
  const near = new Near({ networkId: "testnet", nodeUrl: rpcUrl, keyStore });
  const account = await near.account(accountId);

  window.__MANDATEOS_E2E_NEAR__ = {
    getAccounts: async () => [{ accountId }],
    signAndSendTransaction: async ({ receiverId, actions }) => {
      const outcome = await account.signAndSendTransaction({ receiverId, actions: nearActions(actions) });
      return { transaction_outcome: { id: outcome.transaction_outcome.id } };
    },
    signAndSendTransactions: async ({ transactions: list }) => {
      const results: Array<{ transaction_outcome: { id: string } }> = [];
      for (const transaction of list) {
        const outcome = await account.signAndSendTransaction({
          receiverId: transaction.receiverId,
          actions: nearActions(transaction.actions),
        });
        results.push({ transaction_outcome: { id: outcome.transaction_outcome.id } });
      }
      return results;
    },
  };
}

function installEvmProvider(): void {
  const privateKey = import.meta.env.VITE_E2E_EVM_PRIVATE_KEY;
  if (!privateKey) throw new Error("VITE_E2E_EVM_PRIVATE_KEY is required");
  const rpcUrl = import.meta.env.VITE_E2E_BASE_RPC_URL ?? "https://sepolia.base.org";
  const account = privateKeyToAccount(privateKey as Hex);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });

  const provider = {
    async request(args: { method: string; params?: unknown }) {
      switch (args.method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return "0x14a34";
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        case "eth_sendTransaction": {
          const [transaction] = args.params as Array<{ to: Address; value?: Hex; data?: Hex; gas?: Hex }>;
          if (!transaction) throw new Error("missing transaction");
          return wallet.sendTransaction({
            account,
            to: transaction.to,
            value: transaction.value ? BigInt(transaction.value) : 0n,
            data: transaction.data,
            ...(transaction.gas ? { gas: BigInt(transaction.gas) } : {}),
          });
        }
        case "eth_signTypedData_v4": {
          const [, typedData] = args.params as [string, string];
          return wallet.signTypedData(JSON.parse(typedData) as Parameters<typeof wallet.signTypedData>[0]);
        }
        case "personal_sign": {
          const [message] = args.params as [Hex];
          return account.signMessage({ message: { raw: message } });
        }
        case "eth_getTransactionReceipt": {
          const [hash] = args.params as [Hex];
          return publicClient.getTransactionReceipt({ hash });
        }
        default:
          throw new Error(`unsupported EVM method ${args.method}`);
      }
    },
  } as unknown as EIP1193Provider;
  window.ethereum = provider;
}

export async function installE2eSigners(): Promise<void> {
  console.info(E2E_SIGNERS_MARKER);
  await installNearSigner();
  installEvmProvider();
}
