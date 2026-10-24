import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { KeyPair, Near, keyStores, type Account } from "near-api-js";
import { bytesToHex, encodeFunctionData, getAddress, hexToBytes, keccak256, stringToHex, type Hex } from "viem";

export const AGENT_FUNCTION_CALL_METHODS = [
  "prepare",
  "authorize",
  "cancel_nonce",
  "renounce_role",
] as const;

export const AGENT_GAS = {
  prepare: "30000000000000",
  authorize: "50000000000000",
} as const;

/**
 * NEAR account of an agent. With an organization id, a short tag derived from
 * it keeps two companies' "Treasury bot" from claiming the same account.
 */
export function proposedAgentAccountId(name: string, parent: string, organizationId?: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (slug.length < 2) throw new Error("agent name must produce at least a two-character account slug");
  const tag = organizationId ? `-${keccak256(stringToHex(organizationId)).slice(2, 8)}` : "";
  const accountId = `${slug}${tag}-agent.${parent}`;
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
export type PaymentRequest = Omit<
  PaymentIntent,
  "gas_limit" | "max_fee_per_gas" | "max_priority_fee_per_gas"
> & Partial<Pick<PaymentIntent, "gas_limit" | "max_fee_per_gas" | "max_priority_fee_per_gas">>;

export interface OmniRolesOperationRequest {
  chain_id: number;
  target: number[];
  value: string;
  calldata: number[];
  allowance_amount: string;
  reference: string;
  gas_limit: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
}

export interface AgentGasQuote {
  gas: {
    gasLimit: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    sufficientBalance: boolean;
  };
  warnings: string[];
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
  gasQuote(input: Pick<PaymentIntent, "token" | "recipient" | "amount">): Promise<AgentGasQuote>;
  requestVisa(opId: number[], invoice?: InvoiceContext): Promise<{ status: number; body: Record<string, unknown> }>;
  recordAuthorization(opId: number[], nearTransactionHash: string): Promise<Record<string, unknown>>;
  recordCancellation(opId: number[], nearTransactionHash: string): Promise<Record<string, unknown>>;
  status(opId: number[]): Promise<Record<string, unknown>>;
}

export type PayResult =
  | { outcome: "authorized"; opId: Hex; nearTransactionHash: string; visa: GuardApproval }
  | { outcome: "escalated"; opId: Hex; escalationId: string | null; reasons: unknown }
  | { outcome: "refused"; opId: Hex; error: string; message: string };

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

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


  async pay(intent: PaymentRequest, invoice?: InvoiceContext): Promise<PayResult> {
    let completeIntent: PaymentIntent;
    if (intent.gas_limit && intent.max_fee_per_gas && intent.max_priority_fee_per_gas) {
      completeIntent = {
        ...intent,
        gas_limit: intent.gas_limit,
        max_fee_per_gas: intent.max_fee_per_gas,
        max_priority_fee_per_gas: intent.max_priority_fee_per_gas,
      };
    } else {
      const quote = await this.api.gasQuote(intent);
      if (quote.warnings.length > 0 || !quote.gas.sufficientBalance) {
        throw new Error(quote.warnings.join(" ") || "agent has insufficient Base gas balance");
      }
      completeIntent = {
        ...intent,
        gas_limit: quote.gas.gasLimit,
        max_fee_per_gas: quote.gas.maxFeePerGas,
        max_priority_fee_per_gas: quote.gas.maxPriorityFeePerGas,
      };
    }
    const prepared = await this.vault.prepare(completeIntent);
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

  async gasQuote(input: Pick<PaymentIntent, "token" | "recipient" | "amount">): Promise<AgentGasQuote> {
    const result = await this.request("/v1/operations/gas-quote", {
      method: "POST",
      body: JSON.stringify({
        token: bytesToHex(Uint8Array.from(input.token)),
        recipient: bytesToHex(Uint8Array.from(input.recipient)),
        amount: input.amount,
      }),
    });
    if (result.status !== 200) throw new Error(String(result.body.message ?? result.body.error ?? "gas quote failed"));
    const gas = result.body.gas;
    if (!gas || typeof gas !== "object") throw new Error("gas quote response is missing gas fields");
    const warnings = Array.isArray(result.body.warnings)
      ? result.body.warnings.filter((warning): warning is string => typeof warning === "string")
      : [];
    if (
      !("gasLimit" in gas) ||
      !("maxFeePerGas" in gas) ||
      !("maxPriorityFeePerGas" in gas) ||
      !("sufficientBalance" in gas)
    ) {
      throw new Error("gas quote response is incomplete");
    }
    return {
      gas: {
        gasLimit: String(gas.gasLimit),
        maxFeePerGas: String(gas.maxFeePerGas),
        maxPriorityFeePerGas: String(gas.maxPriorityFeePerGas),
        sufficientBalance: gas.sufficientBalance === true,
      },
      warnings,
    };
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

export interface AgentNearAccount {
  functionCall(input: {
    contractId: string;
    methodName: string;
    args: Record<string, unknown>;
    gas: string;
    attachedDeposit: string;
  }): Promise<{ transaction_outcome: { id: string } }>;
}

const erc20TransferAbi = [{
  type: "function",
  name: "transfer",
  stateMutability: "nonpayable",
  inputs: [
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ type: "bool" }],
}] as const;

export function omniRolesPaymentRequest(
  intent: PaymentIntent,
  chainId: number,
): OmniRolesOperationRequest {
  const token = getAddress(bytesToHex(Uint8Array.from(intent.token)));
  const recipient = getAddress(bytesToHex(Uint8Array.from(intent.recipient)));
  const calldata = encodeFunctionData({
    abi: erc20TransferAbi,
    functionName: "transfer",
    args: [recipient, BigInt(intent.amount)],
  });
  return {
    chain_id: chainId,
    target: evmAddressBytes(token),
    value: "0",
    calldata: Array.from(hexToBytes(calldata)),
    allowance_amount: intent.amount,
    reference: intent.reference,
    gas_limit: intent.gas_limit,
    max_fee_per_gas: intent.max_fee_per_gas,
    max_priority_fee_per_gas: intent.max_priority_fee_per_gas,
  };
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
    private readonly role: string,
    private readonly chainId: number,
  ) {}

  static async connect(input: {
    networkId: string;
    rpcUrl: string;
    accountId: string;
    privateKey: string;
    vaultAccountId: string;
    role: string;
    chainId: number;
  }): Promise<NearVaultGateway> {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(
      input.networkId,
      input.accountId,
      KeyPair.fromString(input.privateKey as `ed25519:${string}`),
    );
    const near = new Near({ networkId: input.networkId, nodeUrl: input.rpcUrl, keyStore });
    return new NearVaultGateway(
      await near.account(input.accountId),
      input.vaultAccountId,
      input.role,
      input.chainId,
    );
  }

  async prepare(intent: PaymentIntent): Promise<PreparedOperation> {
    const request = omniRolesPaymentRequest(intent, this.chainId);
    const outcome = await this.call("prepare", { role: this.role, request }, AGENT_GAS.prepare);
    const operation = decodeNearSuccessValue(outcome);
    if (
      !operation ||
      typeof operation !== "object" ||
      !("op_id" in operation) ||
      !isNumberArray(operation.op_id) ||
      !("state" in operation) ||
      typeof operation.state !== "string"
    ) {
      throw new Error("OmniRoles prepare did not return an operation");
    }
    return { ...operation, op_id: operation.op_id, state: operation.state };
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

  async renounceRole(): Promise<string> {
    const outcome = await this.call("renounce_role", { role: this.role }, AGENT_GAS.prepare);
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
