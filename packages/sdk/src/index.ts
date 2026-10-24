import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { KeyPair, Near, keyStores, type Account } from "near-api-js";
import { bytesToHex, getAddress, hexToBytes, type Address, type Hex } from "viem";

export const AGENT_FUNCTION_CALL_METHODS = [
  "prepare",
  "authorize",
  "cancel_nonce",
  "request_derived_public_key",
] as const;

export const AGENT_GAS = {
  requestDerivedPublicKey: "50000000000000",
  prepare: "10000000000000",
  authorize: "50000000000000",
} as const;

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

export interface PaymentIntent {
  token: number[];
  recipient: number[];
  amount: string;
  reference: string;
  gas_limit: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
}

export interface PreparedOperation {
  op_id: number[];
  state: string;
  [key: string]: unknown;
}

export interface GuardApproval {
  visa: Record<string, unknown>;
  signature: string;
}

export interface CancellationFees {
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

export interface InvoiceContext {
  text?: string;
  claimedRecipient?: Hex;
}

export interface VaultGateway {
  prepare(intent: PaymentIntent): Promise<PreparedOperation>;
  authorize(opId: number[], approval: GuardApproval): Promise<string>;
  cancelNonce(opId: number[], fees: CancellationFees): Promise<string>;
}

export interface AgentApiGateway {
  requestVisa(opId: number[], invoice?: InvoiceContext): Promise<{ status: number; body: Record<string, unknown> }>;
  recordAuthorization(opId: number[], nearTransactionHash: string): Promise<Record<string, unknown>>;
  recordCancellation(opId: number[], nearTransactionHash: string): Promise<Record<string, unknown>>;
  status(opId: number[]): Promise<Record<string, unknown>>;
}

export type PayResult =
  | { outcome: "authorized"; opId: Hex; nearTransactionHash: string; visa: GuardApproval }
  | { outcome: "escalated"; opId: Hex; escalationId: string | null; reasons: unknown }
  | { outcome: "refused"; opId: Hex; error: string; message: string };

export function operationIdHex(opId: number[]): Hex {
  if (opId.length !== 32) throw new Error("operation id must contain 32 bytes");
  return bytesToHex(Uint8Array.from(opId));
}

export function operationIdBytes(opId: Hex): number[] {
  if (!/^0x[0-9a-fA-F]{64}$/.test(opId)) throw new Error("operation id must be 32-byte hex");
  return Array.from(hexToBytes(opId));
}

export function evmAddressBytes(address: Hex): number[] {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("EVM address must contain 20 bytes");
  return Array.from(hexToBytes(address));
}
export class MandateAgentClient {
  constructor(
    private readonly vault: VaultGateway,
    private readonly api: AgentApiGateway,
  ) {}


  async pay(intent: PaymentIntent, invoice?: InvoiceContext): Promise<PayResult> {
    const prepared = await this.vault.prepare(intent);
    const opId = operationIdHex(prepared.op_id);
    const visaResponse = await this.api.requestVisa(prepared.op_id, invoice);
    if (visaResponse.status === 202) {
      return {
        outcome: "escalated",
        opId,
        escalationId: typeof visaResponse.body.escalationId === "string" ? visaResponse.body.escalationId : null,
        reasons: visaResponse.body.reasons ?? [],
      };
    }
    if (visaResponse.status !== 200) {
      return {
        outcome: "refused",
        opId,
        error: String(visaResponse.body.error ?? "payment_refused"),
        message: String(visaResponse.body.message ?? "payment refused"),
      };
    }
    if (
      !visaResponse.body.visa ||
      typeof visaResponse.body.visa !== "object" ||
      typeof visaResponse.body.signature !== "string"
    ) {
      throw new Error("Guard response is missing the signed visa");
    }
    const approval: GuardApproval = {
      visa: visaResponse.body.visa as Record<string, unknown>,
      signature: visaResponse.body.signature,
    };
    const nearTransactionHash = await this.vault.authorize(prepared.op_id, approval);
    await this.api.recordAuthorization(prepared.op_id, nearTransactionHash);
    return { outcome: "authorized", opId, nearTransactionHash, visa: approval };
  }

  status(opId: Hex | number[]): Promise<Record<string, unknown>> {
    return this.api.status(Array.isArray(opId) ? opId : operationIdBytes(opId));
  }

  async cancel(opId: Hex | number[], fees: CancellationFees): Promise<{
    opId: Hex;
    nearTransactionHash: string;
  }> {
    const bytes = Array.isArray(opId) ? opId : operationIdBytes(opId);
    const nearTransactionHash = await this.vault.cancelNonce(bytes, fees);
    await this.api.recordCancellation(bytes, nearTransactionHash);
    return { opId: operationIdHex(bytes), nearTransactionHash };
  }

  async waitForTerminal(
    opId: Hex | number[],
    options: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const intervalMs = options.intervalMs ?? 2_000;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const current = await this.status(opId);
      if (["Confirmed", "Cancelled", "Expired", "Rejected", "Reverted"].includes(String(current.status))) {
        return current;
      }
      if (Date.now() >= deadline) throw new Error(`operation status timed out after ${timeoutMs}ms`);
      await sleep(intervalMs);
    }
  }
}

export class HttpAgentApi implements AgentApiGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  requestVisa(opId: number[], invoice?: InvoiceContext): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.request("/v1/operations/pay", {
      method: "POST",
      body: JSON.stringify({ opId, ...(invoice ? { invoice } : {}) }),
    });
  }

  async recordAuthorization(opId: number[], nearTransactionHash: string): Promise<Record<string, unknown>> {
    const result = await this.request(`/v1/operations/${operationIdHex(opId)}/authorization`, {
      method: "POST",
      body: JSON.stringify({ nearTransactionHash }),
    });
    if (result.status !== 200) throw new Error(String(result.body.message ?? result.body.error ?? "authorization registration failed"));
    return result.body;
  }

  async recordCancellation(opId: number[], nearTransactionHash: string): Promise<Record<string, unknown>> {
    const result = await this.request(`/v1/operations/${operationIdHex(opId)}/cancellation`, {
      method: "POST",
      body: JSON.stringify({ nearTransactionHash }),
    });
    if (result.status !== 200) throw new Error(String(result.body.message ?? result.body.error ?? "cancellation registration failed"));
    return result.body;
  }

  async status(opId: number[]): Promise<Record<string, unknown>> {
    const result = await this.request(`/v1/operations/${operationIdHex(opId)}`, { method: "GET" });
    if (result.status !== 200) throw new Error(String(result.body.message ?? result.body.error ?? "status lookup failed"));
    return result.body;
  }

  private async request(path: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        ...(init.headers ?? {}),
      },
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { status: response.status, body };
  }
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
      gas: AGENT_GAS.requestDerivedPublicKey,
      attachedDeposit: "0",
    }).then((outcome) => outcome.transaction_outcome.id);
    const nearTransactionHash = await this.derivationRequest;
    const attempts = options.attempts ?? 20;
    const intervalMs = options.intervalMs ?? 1_000;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const state = await this.getAgent();
      const address = decodeAgentEvmAddress(state?.evm_address);
      if (address) return { address, requested, nearTransactionHash };
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
      gas: AGENT_GAS.prepare,
      attachedDeposit: "0",
    });
  }

  async authorize(opId: number[] | string, approval: Record<string, unknown>): Promise<unknown> {
    return this.account.functionCall({
      contractId: this.vaultAccountId,
      methodName: "authorize",
      args: { op_id: opId, approval },
      gas: AGENT_GAS.authorize,
      attachedDeposit: "0",
    });
  }
}

export function decodeNearSuccessValue(outcome: unknown): unknown {
  if (!outcome || typeof outcome !== "object" || !("status" in outcome)) return null;
  const status = outcome.status;
  if (!status || typeof status !== "object" || !("SuccessValue" in status) || typeof status.SuccessValue !== "string") {
    return null;
  }
  const decoded = Buffer.from(status.SuccessValue, "base64").toString("utf8");
  return decoded ? JSON.parse(decoded) : null;
}

export class NearVaultGateway implements VaultGateway {
  private readonly agent: NearAgentVaultClient;

  private constructor(
    private readonly account: Account,
    private readonly accountId: string,
    private readonly vaultAccountId: string,
  ) {
    this.agent = new NearAgentVaultClient(
      account as unknown as AgentNearAccount,
      accountId,
      vaultAccountId,
    );
  }

  static async connect(input: {
    networkId: string;
    rpcUrl: string;
    accountId: string;
    privateKey: string;
    vaultAccountId: string;
  }): Promise<NearVaultGateway> {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(
      input.networkId,
      input.accountId,
      KeyPair.fromString(input.privateKey as `ed25519:${string}`),
    );
    const near = new Near({ networkId: input.networkId, nodeUrl: input.rpcUrl, keyStore });
    return new NearVaultGateway(await near.account(input.accountId), input.accountId, input.vaultAccountId);
  }

  async prepare(intent: PaymentIntent): Promise<PreparedOperation> {
    await this.agent.ensureDerivedAddress();
    const outcome = await this.call("prepare", { intent }, AGENT_GAS.prepare);
    const operation = decodeNearSuccessValue(outcome);
    if (!operation || typeof operation !== "object" || !("op_id" in operation)) {
      throw new Error("Vault prepare did not return an operation");
    }
    return operation as PreparedOperation;
  }

  async authorize(opId: number[], approval: GuardApproval): Promise<string> {
    const outcome = await this.call("authorize", { op_id: opId, approval }, AGENT_GAS.authorize);
    return outcome.transaction_outcome.id;
  }

  async cancelNonce(opId: number[], fees: CancellationFees): Promise<string> {
    const outcome = await this.call("cancel_nonce", {
      op_id: opId,
      gas_limit: fees.gasLimit,
      max_fee_per_gas: fees.maxFeePerGas,
      max_priority_fee_per_gas: fees.maxPriorityFeePerGas,
    }, AGENT_GAS.authorize);
    return outcome.transaction_outcome.id;
  }

  private call(methodName: string, args: Record<string, unknown>, gas: string) {
    return this.account.functionCall({
      contractId: this.vaultAccountId,
      methodName,
      args,
      gas,
      attachedDeposit: "0",
    });
  }
}
