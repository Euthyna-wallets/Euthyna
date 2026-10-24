import { describe, expect, it } from "vitest";

import { AGENT_FUNCTION_CALL_METHODS } from "@mandateos/sdk";

import { attestAgentAccessKeys } from "./agent-provisioning.js";

const expected = {
  accountId: "compta-bot-agent.mandateos.testnet",
  publicKey: "ed25519:11111111111111111111111111111111",
  vaultAccountId: "vault.testnet",
  methodNames: [...AGENT_FUNCTION_CALL_METHODS],
  allowanceYocto: null,
};

const restrictedKey = {
  public_key: expected.publicKey,
  access_key: {
    nonce: 0,
    permission: {
      FunctionCall: {
        allowance: null,
        receiver_id: expected.vaultAccountId,
        method_names: [...expected.methodNames],
      },
    },
  },
};

describe("attestAgentAccessKeys", () => {
  it("accepts exactly one restricted FunctionCall key", () => {
    expect(attestAgentAccessKeys([restrictedKey], expected)).toMatchObject({
      valid: true,
      keyCount: 1,
      permission: "FunctionCall",
      receiverId: expected.vaultAccountId,
      methodNames: [...expected.methodNames].sort(),
    });
  });

  it("rejects full-access, extra keys, receiver drift and method drift", () => {
    expect(attestAgentAccessKeys([{
      ...restrictedKey,
      access_key: { nonce: 0, permission: "FullAccess" },
    }], expected).valid).toBe(false);
    expect(attestAgentAccessKeys([restrictedKey, restrictedKey], expected).valid).toBe(false);
    expect(attestAgentAccessKeys([{
      ...restrictedKey,
      access_key: { permission: { FunctionCall: {
        ...restrictedKey.access_key.permission.FunctionCall,
        receiver_id: "evil.testnet",
      } } },
    }], expected).valid).toBe(false);
    expect(attestAgentAccessKeys([{
      ...restrictedKey,
      access_key: { permission: { FunctionCall: {
        ...restrictedKey.access_key.permission.FunctionCall,
        method_names: ["prepare", "delete_account"],
      } } },
    }], expected).valid).toBe(false);
  });
});
