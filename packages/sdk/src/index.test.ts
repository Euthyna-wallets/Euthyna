import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_FUNCTION_CALL_METHODS,
  AGENT_GAS,
  AgentDerivationPendingError,
  AgentNotRegisteredError,
  FileAgentKeyStore,
  NearAgentVaultClient,
  proposedAgentAccountId,
  type AgentNearAccount,
  type VaultAgentState,
} from "./index.js";

const derivedBytes = Array.from(Buffer.from("1111111111111111111111111111111111111111", "hex"));
const registered = (evm: number[] | null): VaultAgentState => ({
  role: "researcher",
  mpc_path: "agents/researcher/base",
  active: true,
  derived_public_key: evm ? "secp256k1:key" : null,
  evm_address: evm,
});

class FakeAccount implements AgentNearAccount {
  views: Array<VaultAgentState | null> = [];
  calls: Array<{ methodName: string; args: Record<string, unknown>; gas: string; deposit: string }> = [];

  viewFunction(): Promise<unknown> {
    return Promise.resolve(this.views.shift() ?? null);
  }

  functionCall(input: {
    methodName: string;
    args: Record<string, unknown>;
    gas: string;
    attachedDeposit: string;
  }): Promise<{ transaction_outcome: { id: string } }> {
    this.calls.push({
      methodName: input.methodName,
      args: input.args,
      gas: input.gas,
      deposit: input.attachedDeposit,
    });
    return Promise.resolve({ transaction_outcome: { id: `tx-${input.methodName}` } });
  }
}

describe("agent init", () => {
  it("derives the proposed account id and stores only a local 0600 key", async () => {
    expect(proposedAgentAccountId("Compta Bot", "mandateos.testnet")).toBe("compta-bot-agent.mandateos.testnet");
    const directory = await mkdtemp(join(tmpdir(), "mandateos-agent-"));
    const path = join(directory, "key.json");
    const store = new FileAgentKeyStore(path);
    const first = await store.loadOrCreate("testnet", "compta-bot-agent.mandateos.testnet");
    const second = await store.loadOrCreate("testnet", "compta-bot-agent.mandateos.testnet");
    expect(second).toEqual(first);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ publicKey: first.publicKey });
    expect(AGENT_FUNCTION_CALL_METHODS).toEqual([
      "prepare",
      "authorize",
      "cancel_nonce",
      "request_derived_public_key",
    ]);
  });
});

describe("NearAgentVaultClient derivation", () => {
  it("does not request derivation when 0xAAA already exists", async () => {
    const account = new FakeAccount();
    account.views.push(registered(derivedBytes));
    const client = new NearAgentVaultClient(account, "agent.testnet", "vault.testnet");
    await expect(client.ensureDerivedAddress()).resolves.toMatchObject({ requested: false });
    expect(account.calls).toEqual([]);
  });

  it("requests derivation exactly once and polls until 0xAAA exists", async () => {
    const account = new FakeAccount();
    account.views.push(registered(null), registered(null), registered(derivedBytes));
    const client = new NearAgentVaultClient(account, "agent.testnet", "vault.testnet");
    await expect(client.ensureDerivedAddress({ attempts: 2, intervalMs: 0 })).resolves.toMatchObject({
      requested: true,
      nearTransactionHash: "tx-request_derived_public_key",
    });
    expect(account.calls).toEqual([{
      methodName: "request_derived_public_key",
      args: { agent: "agent.testnet" },
      gas: AGENT_GAS.requestDerivedPublicKey,
      deposit: "0",
    }]);
  });

  it("fails explicitly before prepare when register_agent has not executed", async () => {
    const account = new FakeAccount();
    account.views.push(null);
    const client = new NearAgentVaultClient(account, "agent.testnet", "vault.testnet");
    await expect(client.prepare({ amount: "1" })).rejects.toBeInstanceOf(AgentNotRegisteredError);
    expect(account.calls).toEqual([]);
  });

  it("fails explicitly when the derivation callback remains pending", async () => {
    const account = new FakeAccount();
    account.views.push(registered(null), registered(null));
    const client = new NearAgentVaultClient(account, "agent.testnet", "vault.testnet");
    await expect(client.ensureDerivedAddress({ attempts: 1, intervalMs: 0 }))
      .rejects.toBeInstanceOf(AgentDerivationPendingError);
  });

  it("does not submit a second derivation request after a pending timeout", async () => {
    const account = new FakeAccount();
    account.views.push(
      registered(null),
      registered(null),
      registered(null),
      registered(derivedBytes),
    );
    const client = new NearAgentVaultClient(account, "agent.testnet", "vault.testnet");
    await expect(client.ensureDerivedAddress({ attempts: 1, intervalMs: 0 }))
      .rejects.toBeInstanceOf(AgentDerivationPendingError);
    await expect(client.ensureDerivedAddress({ attempts: 1, intervalMs: 0 }))
      .resolves.toMatchObject({ requested: false });
    expect(account.calls).toHaveLength(1);
  });
  it("uses measured gas limits for prepare and authorize", async () => {
    const account = new FakeAccount();
    account.views.push(registered(derivedBytes));
    const client = new NearAgentVaultClient(account, "agent.testnet", "vault.testnet");
    await client.prepare({ amount: "1" });
    await client.authorize([1, 2], { visa: {} });
    expect(account.calls.map(({ methodName, gas }) => ({ methodName, gas }))).toEqual([
      { methodName: "prepare", gas: AGENT_GAS.prepare },
      { methodName: "authorize", gas: AGENT_GAS.authorize },
    ]);
  });
});
