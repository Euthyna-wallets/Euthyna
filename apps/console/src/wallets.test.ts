import { afterEach, describe, expect, it, vi } from "vitest";

import { readAgentAccessKeyRpc } from "./wallets.js";

function rpcRawResult(value: unknown): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: "mandateos-browser",
    result: value,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("readAgentAccessKeyRpc", () => {
  it("accepts exactly one FunctionCall key limited to the Vault methods", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rpcRawResult({
      keys: [{
        public_key: "ed25519:agent",
        access_key: {
          permission: {
            FunctionCall: {
              allowance: null,
              receiver_id: "vault.testnet",
              method_names: ["prepare", "authorize", "cancel_nonce", "renounce_role"],
            },
          },
        },
      }],
    })));
    await expect(readAgentAccessKeyRpc({
      accountId: "agent.testnet",
      publicKey: "ed25519:agent",
      vaultAccountId: "vault.testnet",
      methodNames: ["prepare", "authorize", "cancel_nonce", "renounce_role"],
      allowanceYocto: null,
    })).resolves.toMatchObject({ valid: true });
  });
});

