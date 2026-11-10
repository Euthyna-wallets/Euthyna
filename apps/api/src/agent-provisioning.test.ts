import { describe, expect, it } from "vitest";

import { AGENT_FUNCTION_CALL_METHODS, BANK_AGENT_METHODS, NEAR_AGENT_METHODS } from "@euthyna/sdk";

import { attestAgentAccessKeys } from "./agent-provisioning.js";

const expected = {
  accountId: "compta-bot-agent.mandateos.testnet",
  publicKey: "ed25519:11111111111111111111111111111111",
  vaultAccountId: "vault.testnet",
  methodNames: [...AGENT_FUNCTION_CALL_METHODS],
  allowanceYocto: null,
  sealed: null,
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

  it("keeps keys made before NEAR transfers valid, flagged as outdated", () => {
    const beforeBank = AGENT_FUNCTION_CALL_METHODS.filter((method) => !(BANK_AGENT_METHODS as readonly string[]).includes(method));
    const legacy = beforeBank.filter((method) => !(NEAR_AGENT_METHODS as readonly string[]).includes(method));
    const key = (methods: string[]) => ({ ...restrictedKey, access_key: { permission: { FunctionCall: { ...restrictedKey.access_key.permission.FunctionCall, method_names: methods } } } });
    expect(attestAgentAccessKeys([key(legacy)], expected)).toMatchObject({ valid: true, outdated: true });
    expect(attestAgentAccessKeys([key(beforeBank)], expected)).toMatchObject({ valid: true, outdated: true });
    expect(attestAgentAccessKeys([restrictedKey], expected)).toMatchObject({ valid: true, outdated: false });
    // Any other list stays refused, more or fewer methods alike.
    expect(attestAgentAccessKeys([key(legacy.slice(1))], expected).valid).toBe(false);
    expect(attestAgentAccessKeys([key([...AGENT_FUNCTION_CALL_METHODS, "ft_transfer"])], expected).valid).toBe(false);
  });

  it("with a sealed key: both keys, each limited to its own contract, and nothing else", () => {
    const sealed = { publicKey: "ed25519:22222222222222222222222222222222", receiverId: "sealed.testnet", methodNames: ["seal", "approve", "fill", "cancel"] };
    const withSealed = { ...expected, sealed };
    const sealedKey = (patch: Record<string, unknown> = {}) => ({
      public_key: sealed.publicKey,
      access_key: { nonce: 0, permission: { FunctionCall: { allowance: null, receiver_id: sealed.receiverId, method_names: [...sealed.methodNames], ...patch } } },
    });
    expect(attestAgentAccessKeys([sealedKey(), restrictedKey], withSealed)).toMatchObject({ valid: true, sealedValid: true, keyCount: 2, publicKey: expected.publicKey });
    // Missing, widened or redirected sealed key; or a third key.
    expect(attestAgentAccessKeys([restrictedKey], withSealed).valid).toBe(false);
    expect(attestAgentAccessKeys([restrictedKey, sealedKey({ method_names: ["seal", "register_reader"] })], withSealed)).toMatchObject({ valid: false, sealedValid: false });
    expect(attestAgentAccessKeys([restrictedKey, sealedKey({ receiver_id: "vault.testnet" })], withSealed).valid).toBe(false);
    expect(attestAgentAccessKeys([restrictedKey, { ...sealedKey(), access_key: { nonce: 0, permission: "FullAccess" } }], withSealed).valid).toBe(false);
    expect(attestAgentAccessKeys([restrictedKey, sealedKey(), { ...restrictedKey, public_key: "ed25519:3333" }], withSealed).valid).toBe(false);
    // An agent without a sealed key is still held to exactly one key.
    expect(attestAgentAccessKeys([restrictedKey, sealedKey()], expected).valid).toBe(false);
  });
});
