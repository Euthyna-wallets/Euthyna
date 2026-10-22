import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";

import { NearClient } from "./near.js";

it("provisions the agent in one transaction with one restricted FunctionCall key", async () => {
  const relayerKey = KeyPair.fromRandom("ed25519").toString();
  const agentKey = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  const calls: Array<{ receiverId: string; actions: unknown[] }> = [];
  const account = {
    signAndSendTransaction: async (input: { receiverId: string; actions: unknown[] }) => {
      calls.push(input);
      return { transaction_outcome: { id: "near-provision-hash" } };
    },
  };
  const near = new NearClient({
    NEAR_NETWORK_ID: "testnet",
    NEAR_RPC_URL: "https://rpc.testnet.near.org",
    NEAR_RELAYER_ACCOUNT_ID: "mandateos.testnet",
    NEAR_RELAYER_PRIVATE_KEY: relayerKey,
  });
  Object.defineProperty(near, "accountPromise", { value: Promise.resolve(account) });
  await expect(near.provisionFunctionCallAccount({
    accountId: "compta-bot-agent.mandateos.testnet",
    publicKey: agentKey,
    receiverId: "vault.testnet",
    methodNames: ["prepare", "authorize", "cancel_nonce", "request_derived_public_key"],
    reserveYocto: "300000000000000000000000",
    allowanceYocto: null,
  })).resolves.toBe("near-provision-hash");

  expect(calls).toHaveLength(1);
  expect(calls[0]?.receiverId).toBe("compta-bot-agent.mandateos.testnet");
  const actions = calls[0]?.actions as Array<{
    createAccount?: unknown;
    transfer?: { deposit?: bigint };
    addKey?: {
      accessKey?: {
        permission?: {
          fullAccess?: unknown;
          functionCall?: { receiverId?: string; methodNames?: string[]; allowance?: bigint };
        };
      };
    };
  }>;
  expect(actions).toHaveLength(3);
  expect(actions[0]?.createAccount).toBeDefined();
  expect(actions[1]?.transfer?.deposit).toBe(300000000000000000000000n);
  expect(actions[2]?.addKey?.accessKey?.permission?.fullAccess).toBeUndefined();
  expect(actions[2]?.addKey?.accessKey?.permission?.functionCall).toMatchObject({
    receiverId: "vault.testnet",
    methodNames: ["prepare", "authorize", "cancel_nonce", "request_derived_public_key"],
    allowance: undefined,
  });
});
