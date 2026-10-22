import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { KeyPair, Near, keyStores } from "near-api-js";
import { bytesToHex, getAddress, type Address } from "viem";

export const AGENT_FUNCTION_CALL_METHODS = [
  "prepare",
  "authorize",
  "cancel_nonce",
  "request_derived_public_key",
] as const;

export function proposedAgentAccountId(name: string, parent: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (slug.length < 2) throw new Error("agent name must produce at least a two-character account slug");
  const accountId = `${slug}-agent.${parent}`;
  if (accountId.length > 64) throw new Error("proposed agent account exceeds NEAR's 64-character limit");
  return accountId;
}

export interface AgentKeyFile {
  networkId: string;
  accountId: string;
  publicKey: string;
  privateKey: string;
}

export class FileAgentKeyStore {
  constructor(readonly path: string) {}

  async loadOrCreate(networkId: string, accountId: string): Promise<AgentKeyFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as AgentKeyFile;
      if (parsed.networkId !== networkId || parsed.accountId !== accountId) {
        throw new Error("stored agent key belongs to another network or account");
      }
      const keyPair = KeyPair.fromString(parsed.privateKey as `ed25519:${string}`);
      if (keyPair.getPublicKey().toString() !== parsed.publicKey) {
        throw new Error("stored agent public/private key mismatch");
      }
      await chmod(this.path, 0o600);
      return parsed;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const keyPair = KeyPair.fromRandom("ed25519");
    const created: AgentKeyFile = {
      networkId,
      accountId,
      publicKey: keyPair.getPublicKey().toString(),
      privateKey: keyPair.toString(),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(created)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
    return created;
  }
}

export interface VaultAgentState {
  role: string;
  mpc_path: string;
  active: boolean;
  derived_public_key: string | null;
  evm_address: number[] | string | null;
}

export function decodeAgentEvmAddress(value: number[] | string | null | undefined): Address | null {
  if (value === null || value === undefined) return null;
  const bytes = Array.isArray(value) ? Uint8Array.from(value) : Uint8Array.from(Buffer.from(value, "base64"));
  if (bytes.length !== 20) throw new Error("Vault agent EVM address must contain 20 bytes");
  return getAddress(bytesToHex(bytes));
}

export class AgentNotRegisteredError extends Error {
  constructor(accountId: string) {
    super(`agent ${accountId} is not registered in the Vault; execute set_role then register_agent first`);
  }
}

export class AgentDerivationPendingError extends Error {
  constructor(accountId: string) {
    super(`agent ${accountId} has no derived 0xAAA yet; request_derived_public_key is still pending`);
  }
}

export interface AgentNearAccount {
  viewFunction(input: {
    contractId: string;
    methodName: string;
    args: Record<string, unknown>;
  }): Promise<unknown>;
  functionCall(input: {
    contractId: string;
    methodName: string;
    args: Record<string, unknown>;
    gas: string;
    attachedDeposit: string;
  }): Promise<{ transaction_outcome: { id: string } }>;
}

export class NearAgentVaultClient {
  private derivationRequest: Promise<string> | null = null;
  constructor(
    private readonly account: AgentNearAccount,
    readonly accountId: string,
    readonly vaultAccountId: string,
  ) {}

  static async connect(input: {
    networkId: string;
    rpcUrl: string;
    accountId: string;
    privateKey: string;
    vaultAccountId: string;
  }): Promise<NearAgentVaultClient> {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(
      input.networkId,
      input.accountId,
      KeyPair.fromString(input.privateKey as `ed25519:${string}`),
    );
    const near = new Near({ networkId: input.networkId, nodeUrl: input.rpcUrl, keyStore });
    const account = await near.account(input.accountId);
    return new NearAgentVaultClient(account as unknown as AgentNearAccount, input.accountId, input.vaultAccountId);
  }

  async getAgent(): Promise<VaultAgentState | null> {
    return this.account.viewFunction({
      contractId: this.vaultAccountId,
      methodName: "get_agent",
      args: { agent: this.accountId },
    }) as Promise<VaultAgentState | null>;
  }

  async ensureDerivedAddress(options: { attempts?: number; intervalMs?: number } = {}): Promise<{
    address: Address;
    requested: boolean;
    nearTransactionHash: string | null;
  }> {
    const initial = await this.getAgent();
    if (!initial) throw new AgentNotRegisteredError(this.accountId);
    const existing = decodeAgentEvmAddress(initial.evm_address);
    if (existing) return { address: existing, requested: false, nearTransactionHash: null };

    const requested = this.derivationRequest === null;
    this.derivationRequest ??= this.account.functionCall({
      contractId: this.vaultAccountId,
      methodName: "request_derived_public_key",
      args: { agent: this.accountId },
      gas: "50000000000000",
      attachedDeposit: "0",
    }).then((outcome) => outcome.transaction_outcome.id);
    const nearTransactionHash = await this.derivationRequest;
    const attempts = options.attempts ?? 20;
    const intervalMs = options.intervalMs ?? 1_000;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const state = await this.getAgent();
      const address = decodeAgentEvmAddress(state?.evm_address);
      if (address) {
        return {
          address,
          requested,
          nearTransactionHash,
        };
      }
      if (attempt + 1 < attempts && intervalMs > 0) await sleep(intervalMs);
    }
    throw new AgentDerivationPendingError(this.accountId);
  }

  async prepare(intent: Record<string, unknown>): Promise<unknown> {
    await this.ensureDerivedAddress();
    return this.account.functionCall({
      contractId: this.vaultAccountId,
      methodName: "prepare",
      args: { intent },
      gas: "120000000000000",
      attachedDeposit: "0",
    });
  }
}
