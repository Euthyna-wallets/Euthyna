/**
 * TEST-ONLY signers injected by the Playwright harness.
 * Never bundled in a production build (guarded by VITE_E2E and checked by
 * src/prod-build.test.ts).
 */
import { serializeNep413 } from "@near-wallet-selector/core";
import { KeyPair, Near, keyStores, transactions } from "near-api-js";

export const E2E_SIGNERS_MARKER = "MANDATEOS_E2E_SIGNERS_V1";

interface SelectorAction {
  type: string;
  params?: Record<string, unknown>;
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
  // A Playwright context can act as another member by seeding this key before the page loads.
  let override: { accountId?: string; privateKey?: string } = {};
  try {
    override = JSON.parse(localStorage.getItem("mandateos.e2e.near") ?? "{}") as typeof override;
  } catch {
    override = {};
  }
  const accountId = override.accountId ?? import.meta.env.VITE_E2E_NEAR_ACCOUNT_ID;
  const privateKey = (override.privateKey ?? import.meta.env.VITE_E2E_NEAR_PRIVATE_KEY) as `ed25519:${string}` | undefined;
  const rpcUrl = import.meta.env.VITE_E2E_NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
  if (!accountId || !privateKey) {
    throw new Error("VITE_E2E_NEAR_ACCOUNT_ID / VITE_E2E_NEAR_PRIVATE_KEY are required");
  }
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey("testnet", accountId, KeyPair.fromString(privateKey));
  const near = new Near({ networkId: "testnet", nodeUrl: rpcUrl, keyStore });
  const account = await near.account(accountId);

  const keyPair = KeyPair.fromString(privateKey);
  window.__MANDATEOS_E2E_NEAR__ = {
    getAccounts: async () => [{ accountId }],
    signMessage: async ({ message, recipient, nonce }) => {
      const payload = serializeNep413({ message, recipient, nonce });
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(payload)));
      return {
        accountId,
        publicKey: keyPair.getPublicKey().toString(),
        signature: Buffer.from(keyPair.sign(digest).signature).toString("base64"),
      };
    },
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

export async function installE2eSigners(): Promise<void> {
  console.info(E2E_SIGNERS_MARKER);
  await installNearSigner();
}
