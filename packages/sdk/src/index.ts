import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { KeyPair, Near, keyStores, type Account } from "near-api-js";
import { bytesToHex, hexToBytes, type Hex } from "viem";

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
  constructor(private readonly path: string) {}

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
    return created;
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
  private constructor(
    private readonly account: Account,
    private readonly vaultAccountId: string,
  ) {}

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
    return new NearVaultGateway(await near.account(input.accountId), input.vaultAccountId);
  }

  async prepare(intent: PaymentIntent): Promise<PreparedOperation> {
    const outcome = await this.call("prepare", { intent }, "120000000000000");
    const operation = decodeNearSuccessValue(outcome);
    if (!operation || typeof operation !== "object" || !("op_id" in operation)) {
      throw new Error("Vault prepare did not return an operation");
    }
    return operation as PreparedOperation;
  }

  async authorize(opId: number[], approval: GuardApproval): Promise<string> {
    const outcome = await this.call("authorize", { op_id: opId, approval }, "120000000000000");
    return outcome.transaction_outcome.id;
  }

  async cancelNonce(opId: number[], fees: CancellationFees): Promise<string> {
    const outcome = await this.call("cancel_nonce", {
      op_id: opId,
      gas_limit: fees.gasLimit,
      max_fee_per_gas: fees.maxFeePerGas,
      max_priority_fee_per_gas: fees.maxPriorityFeePerGas,
    }, "120000000000000");
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
