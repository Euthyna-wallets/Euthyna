import { afterEach, describe, expect, it, vi } from "vitest";

import type { TreasuryPlan } from "./api.js";
import { DAO_VOTE_GAS, findDaoProposalRpc, readAgentAccessKeyRpc, readDaoPolicyRpc, readDaoProposalRpc, readNearDeploymentRpc } from "./wallets.js";

function rpcResult(value: unknown): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: "mandateos-browser",
    result: { result: [...new TextEncoder().encode(JSON.stringify(value))] },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function rpcRawResult(value: unknown): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: "mandateos-browser",
    result: value,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("readDaoPolicyRpc", () => {
  it("reads and normalizes council, threshold and factory warning directly from RPC", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcResult({
        roles: [{ name: "council", kind: { Group: ["carol.testnet", "alice.testnet", "bob.testnet"] } }],
        default_vote_policy: { threshold: "2" },
      }))
      .mockResolvedValueOnce(rpcResult({ factory_id: "factory-v2.mandateos.testnet", auto_update: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(readDaoPolicyRpc("acme.factory-v2.mandateos.testnet")).resolves.toEqual({
      council: ["alice.testnet", "bob.testnet", "carol.testnet"],
      threshold: "2",
      autoUpdate: true,
      factoryId: "factory-v2.mandateos.testnet",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a response without an exact council group", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rpcResult({ roles: [], default_vote_policy: { threshold: "2" } })));
    await expect(readDaoPolicyRpc("bad.factory-v2.mandateos.testnet")).rejects.toThrow(
      "DAO council role missing",
    );
  });
});

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
              method_names: ["prepare", "authorize", "cancel_nonce", "request_derived_public_key"],
            },
          },
        },
      }],
    })));
    await expect(readAgentAccessKeyRpc({
      accountId: "agent.testnet",
      publicKey: "ed25519:agent",
      vaultAccountId: "vault.testnet",
      methodNames: ["prepare", "authorize", "cancel_nonce", "request_derived_public_key"],
      allowanceYocto: null,
    })).resolves.toMatchObject({ valid: true });
  });
});

describe("DAO proposal tracking", () => {
  it("finds the latest deterministic proposal and maps terminal states", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rpcResult(42))
      .mockResolvedValueOnce(rpcResult([
        { id: 11, description: "step", status: "Approved" },
        { id: 41, description: "step", status: "Expired" },
      ]))
      .mockResolvedValueOnce(rpcResult({ id: 43, description: "failed", status: "Rejected" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(findDaoProposalRpc("dao.testnet", "step")).resolves.toEqual({
      id: 41,
      description: "step",
      state: "Expired",
      rawStatus: "Expired",
    });
    await expect(readDaoProposalRpc("dao.testnet", 43)).resolves.toMatchObject({ state: "Failed" });
    expect(DAO_VOTE_GAS).toBe("450000000000000");
  });
});

describe("readNearDeploymentRpc", () => {
  it("checks hashes, zero keys and initialization fields without using the API", async () => {
    const expectedHash = "AqMJR7ftwLs78D9ERv3eVZpAy8DjobFANTWZ6awc1Vnc";
    const delay = Buffer.from("4444444444444444444444444444444444444444", "hex").toString("base64");
    const plan = {
      environment: "uat",
      daoAccountId: "acme.factory.mandateos.testnet",
      vault: {
        accountId: "acme-v.mandateos.testnet",
        wasmSha256: "921c03c78a759dc11976501f5b8f81a514820dad57d62e3f28c0cf12034767f5",
        initArgs: {
          owner_id: "acme.factory.mandateos.testnet",
          mpc_contract_id: "v1.signer-prod.testnet",
          evm_chain_id: 84532,
          token_id: "token.testnet",
          guard_public_key: "guard",
          reservation_ttl_blocks: 50,
        },
      },
      relay: {
        accountId: "acme-r.mandateos.testnet",
        wasmSha256: "921c03c78a759dc11976501f5b8f81a514820dad57d62e3f28c0cf12034767f5",
        initArgs: {
          owner_id: "acme.factory.mandateos.testnet",
          mpc_contract_id: "v1.signer-prod.testnet",
          mpc_path: "governance/base-sepolia",
          evm_chain_id: 84532,
          delay_address: delay,
        },
      },
    } as TreasuryPlan;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rpcRawResult({ code_hash: expectedHash }))
      .mockResolvedValueOnce(rpcRawResult({ keys: [] }))
      .mockResolvedValueOnce(rpcRawResult({ code_hash: expectedHash }))
      .mockResolvedValueOnce(rpcRawResult({ keys: [] }))
      .mockResolvedValueOnce(rpcResult(plan.daoAccountId))
      .mockResolvedValueOnce(rpcResult(plan.vault.initArgs.mpc_contract_id))
      .mockResolvedValueOnce(rpcResult(84532))
      .mockResolvedValueOnce(rpcResult(plan.vault.initArgs.token_id))
      .mockResolvedValueOnce(rpcResult(plan.vault.initArgs.guard_public_key))
      .mockResolvedValueOnce(rpcResult(50))
      .mockResolvedValueOnce(rpcResult(plan.daoAccountId))
      .mockResolvedValueOnce(rpcResult(plan.relay.initArgs.mpc_contract_id))
      .mockResolvedValueOnce(rpcResult(plan.relay.initArgs.mpc_path))
      .mockResolvedValueOnce(rpcResult(84532))
      .mockResolvedValueOnce(rpcResult(delay));
    vi.stubGlobal("fetch", fetchMock);

    const attestation = await readNearDeploymentRpc(plan);
    expect(attestation.valid).toBe(true);
    expect(attestation.checks).toHaveLength(15);
    expect(attestation.checks.every((check) => check.ok)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(15);
  });
});
