import { relayedCall, type DelegateRelay, type RelayOutcome } from "./meta-tx.js";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { KeyPair, Near, keyStores, type Account } from "near-api-js";

import type { AgentNearSigner, SignerSocket } from "./signer-socket.js";

export { SignerError, SignerSocket, SocketNearSigner, type AgentNearSigner } from "./signer-socket.js";
import { bytesToHex, encodeFunctionData, getAddress, hexToBytes, keccak256, stringToHex, type Hex } from "viem";

export const AGENT_FUNCTION_CALL_METHODS = [
  "prepare",
  "prepare_with_approval",
  "authorize",
  "cancel_nonce",
  "settle",
  "settle_cancellation",
  "release_unconfirmed",
  "execute_queued_operation",
  "cancel_prepared",
  "renounce_role",
  "execute_solana",
  "settle_solana",
  "release_solana_unconfirmed",
  "execute_near",
  "release_near_unconfirmed",
  "request_bank_payout",
] as const;

/** Methods NEAR-transfer agents add; keys made before them still work for everything else. */
export const NEAR_AGENT_METHODS = ["execute_near", "release_near_unconfirmed"] as const;
/** Method euro-payout agents add (bank payouts to voted IBANs). */
export const BANK_AGENT_METHODS = ["request_bank_payout"] as const;
/** Agent key method lists accepted on chain, newest first. */
export const AGENT_METHOD_GENERATIONS: ReadonlyArray<readonly string[]> = [
  AGENT_FUNCTION_CALL_METHODS,
  AGENT_FUNCTION_CALL_METHODS.filter((method) => !(BANK_AGENT_METHODS as readonly string[]).includes(method)),
  AGENT_FUNCTION_CALL_METHODS.filter((method) => !(BANK_AGENT_METHODS as readonly string[]).includes(method) && !(NEAR_AGENT_METHODS as readonly string[]).includes(method)),
];

export const AGENT_GAS = {
  prepare: "30000000000000",
  prepareWithApproval: "60000000000000",
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

export { cardAccountIdOf } from "./roles.js";

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

/**
 * A token the call's target may take, for this call only (a swap's input). With sponsored gas
 * (EIP-7702) the wallet runs approve(target, amount), the call and approve(target, 0) as one
 * transaction: no approval is left behind.
 */
export interface TokenApproval {
  token: number[];
  amount: string;
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



export interface InvoiceContext {
  text?: string;
  claimedRecipient?: Hex;
}

export interface VaultGateway {
  prepare(intent: PaymentIntent): Promise<PreparedOperation>;
  /** Any call the role allows (not only a token transfer). */
  prepareRequest?(request: OmniRolesOperationRequest, approval?: TokenApproval): Promise<PreparedOperation>;
  authorize(opId: number[], approval: GuardApproval | null): Promise<string>;
  cancelNonce(opId: number[]): Promise<string>;
  /** Release a prepared operation the Guard refused, so the wallet is free again. */
  cancelPrepared?(opId: number[]): Promise<string>;
}

export interface AgentApiGateway {
  preflightInvoice?(request: OmniRolesOperationRequest, invoice?: InvoiceContext): Promise<void>;
  gasQuote(input: Pick<PaymentIntent, "token" | "recipient" | "amount">): Promise<AgentGasQuote>;
  requestVisa(opId: number[], invoice?: InvoiceContext): Promise<{ status: number; body: Record<string, unknown> }>;
  recordAuthorization(opId: number[], nearTransactionHash: string): Promise<Record<string, unknown>>;
  recordCancellation(opId: number[], nearTransactionHash: string): Promise<Record<string, unknown>>;
  status(opId: number[]): Promise<Record<string, unknown>>;
  /** Dry run: the vault's verdict, then the Guard's. Nothing is reserved. */
  check?(request: OmniRolesOperationRequest): Promise<OperationCheckResult>;
  /** Tells the API about an operation signed on chain without it, so the relayer sends it now. */
  announce?(opId: number[]): Promise<void>;
  /** Tells the API this agent just acted on its vault without it, so the vault is read now. */
  wake?(): Promise<void>;
  /** Before a heavy call the agent signs itself: the API tops its NEAR for gas up, and answers once done. */
  gas?(): Promise<void>;
  /** Asks Euthyna's tank for the SOL the company's Solana wallet needs to pay a transfer's fee. */
  solanaFuel?(): Promise<{ status: string; signature?: string }>;
  /** The agent's role, what is left of its budgets, and the recipients the Guard accepts. */
  mandate?(): Promise<Record<string, unknown>>;
  /** The bridge call that sends `amountWei` of revenue to the company's shareholders. */
  shareRevenue?(amountWei: string): Promise<ShareRevenueOperation>;
}

/** ETH to the company's shares contract on NEAR, through the Omni Bridge. */
export interface ShareRevenueOperation {
  chainId: number;
  to: Hex;
  data: Hex;
  value: string;
  allowanceAmount: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  recipient: string;
  bridgeFee: string;
  sharesAccountId: string;
}

export interface OperationCheckResult {
  allowed: boolean;
  /** "vault" (on-chain rule) or "guard" (suppliers, reused reference). */
  refusedBy: "vault" | "guard" | null;
  reason: string | null;
  explanation: string | null;
  requires_delay: boolean;
  requires_cosign: boolean;
  wallet_busy?: boolean;
}

/** Any call from the company wallet; `allowanceAmount` is the budget it consumes. */
export interface CallRequest {
  chainId: number;
  to: Hex;
  value?: string;
  data?: Hex;
  reference: string;
  allowanceAmount?: string;
}

export type PayResult =
  | { outcome: "authorized"; opId: Hex; nearTransactionHash: string; visa: GuardApproval }
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
    // The vault's verdict first (a dry run of the same on-chain rules): a payment the role forbids
    // is refused for that reason, before any network fee is quoted from the company wallet.
    if (this.api.check) {
      const verdict = await this.check(intent).catch(() => null);
      if (verdict && !verdict.allowed && verdict.refusedBy === "vault") throw new Error(`Refused by the vault: ${verdict.reason}`);
    }
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
    await this.api.preflightInvoice?.(omniRolesPaymentRequest(completeIntent, 84532), invoice);
    return this.submit(await this.vault.prepare(completeIntent), invoice);
  }

  /** Any call the role allows: prepare, Guard visa, authorize. */
  async call(request: OmniRolesOperationRequest, approval?: TokenApproval): Promise<PayResult> {
    if (!this.vault.prepareRequest) throw new Error("this vault gateway only prepares token transfers");
    return this.submit(await this.vault.prepareRequest(request, approval));
  }

  /**
   * Send `amountWei` of ETH from the company wallet to the shareholders. The
   * API builds the bridge call; the vault signs it only if the role allows
   * exactly this recipient and what is left of the budget.
   */
  async shareRevenue(amountWei: string, reference: string): Promise<PayResult & { recipient?: string; bridgeFee?: string }> {
    if (!this.api.shareRevenue) throw new Error("this API does not support revenue sharing");
    const operation = await this.api.shareRevenue(amountWei);
    const result = await this.call({
      chain_id: operation.chainId,
      target: evmAddressBytes(operation.to),
      value: operation.value,
      calldata: Array.from(hexToBytes(operation.data)),
      allowance_amount: operation.allowanceAmount,
      reference,
      gas_limit: operation.gasLimit,
      max_fee_per_gas: operation.maxFeePerGas,
      max_priority_fee_per_gas: operation.maxPriorityFeePerGas,
    });
    return { ...result, recipient: operation.recipient, bridgeFee: operation.bridgeFee };
  }

  private async submit(prepared: PreparedOperation, invoice?: InvoiceContext): Promise<PayResult> {
    const opId = operationIdHex(prepared.op_id);
    const visaResponse = await this.api.requestVisa(prepared.op_id, invoice);
    if (visaResponse.status !== 200) {
      // Refused: there is no human escalation. Free the wallet right away.
      await this.vault.cancelPrepared?.(prepared.op_id).catch(() => undefined);
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

  /**
   * Would this be allowed? A token transfer (`PaymentRequest`) or any call
   * (`CallRequest`). The dry run does not check network fees.
   */
  check(request: PaymentRequest | CallRequest, chainId = 84532): Promise<OperationCheckResult> {
    if (!this.api.check) throw new Error("this API does not support checks");
    const noFees = { gas_limit: "0", max_fee_per_gas: "0", max_priority_fee_per_gas: "0" };
    const operation: OmniRolesOperationRequest = "token" in request
      ? omniRolesPaymentRequest({ ...request, ...noFees }, chainId)
      : {
        chain_id: request.chainId,
        target: evmAddressBytes(request.to),
        value: request.value ?? "0",
        calldata: Array.from(hexToBytes(request.data ?? "0x")),
        allowance_amount: request.allowanceAmount ?? "0",
        reference: request.reference,
        ...noFees,
      };
    return this.api.check(operation);
  }

  mandate(): Promise<Record<string, unknown>> {
    if (!this.api.mandate) throw new Error("this API does not expose the mandate");
    return this.api.mandate();
  }


  async cancel(opId: Hex | number[]): Promise<{
    opId: Hex;
    nearTransactionHash: string;
  }> {
    const bytes = Array.isArray(opId) ? opId : operationIdBytes(opId);
    const nearTransactionHash = await this.vault.cancelNonce(bytes);
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

  async preflightInvoice(request: OmniRolesOperationRequest, invoice?: InvoiceContext): Promise<void> {
    let response: { status: number; body: Record<string, unknown> };
    try { response = await this.request("/v1/operations/check", { method: "POST", body: JSON.stringify({ request, invoice, advisoryOnly: true }), signal: AbortSignal.timeout(5_000) }); }
    catch { return; }
    if (response.status === 200 && response.body.allowed === false) throw new Error(`Invoice refused: ${String(response.body.reason)}`);
  }

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

  async wake(): Promise<void> {
    await this.request("/v1/agent/wake", { method: "POST", body: "{}", signal: AbortSignal.timeout(5_000) });
  }

  async gas(): Promise<void> {
    await this.request("/v1/agent/gas", { method: "POST", body: "{}", signal: AbortSignal.timeout(20_000) });
  }

  /** Has the relayer send a signed delegate and pay its gas; null when it does not (off, quota): the agent sends it. */
  async relay(signedDelegate: string): Promise<RelayOutcome | null> {
    const response = await this.request("/v1/agent/relay", { method: "POST", body: JSON.stringify({ signedDelegate }), signal: AbortSignal.timeout(90_000) });
    if (response.status === 200 && response.body.outcome) return response.body.outcome as RelayOutcome;
    if (response.status === 503 || response.status === 429 || response.status === 404) return null;
    throw new Error(`relay refused: ${String(response.body.error ?? response.status)} ${String(response.body.message ?? "")}`.trim());
  }

  async solanaFuel(): Promise<{ status: string; signature?: string }> {
    const response = await this.request("/v1/agent/solana/fuel", { method: "POST", body: "{}", signal: AbortSignal.timeout(30_000) });
    return { status: String(response.body.status ?? response.status), ...(typeof response.body.signature === "string" ? { signature: response.body.signature } : {}) };
  }

  async announce(opId: number[]): Promise<void> {
    const response = await this.request(`/v1/operations/${operationIdHex(opId)}/announce`, { method: "POST", body: "{}", signal: AbortSignal.timeout(10_000) });
    if (response.status >= 300) throw new Error(`announce refused: ${String(response.body.error ?? response.status)}`);
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

  async check(request: OmniRolesOperationRequest): Promise<OperationCheckResult> {
    const result = await this.request("/v1/operations/check", { method: "POST", body: JSON.stringify({ request }) });
    if (result.status !== 200) throw new Error(String(result.body.message ?? result.body.error ?? "check failed"));
    return result.body as unknown as OperationCheckResult;
  }

  async mandate(): Promise<Record<string, unknown>> {
    const result = await this.request("/v1/agent/mandate", { method: "GET" });
    if (result.status !== 200) throw new Error(String(result.body.message ?? result.body.error ?? "mandate lookup failed"));
    return result.body;
  }

  async shareRevenue(amountWei: string): Promise<ShareRevenueOperation> {
    const result = await this.request(`/v1/agent/share-revenue?amountWei=${encodeURIComponent(amountWei)}`, { method: "GET" });
    if (result.status !== 200) throw new Error(String(result.body.message ?? result.body.error ?? "revenue transfer could not be prepared"));
    return result.body as unknown as ShareRevenueOperation;
  }


  protected async request(path: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
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

/**
 * The agent API through euthyna-signer: the signer holds the agent's API key
 * and forwards only the agent endpoints, so this process has no secret.
 */
export class SignerAgentApi extends HttpAgentApi {
  constructor(private readonly socket: SignerSocket, private readonly agentAccountId: string) {
    super("", "");
  }

  protected override async request(path: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) as unknown : undefined;
    const reply = await this.socket.call({ op: "api", agent: this.agentAccountId, method, path, ...(body === undefined ? {} : { body }) });
    return { status: Number(reply.status), body: (reply.body ?? {}) as Record<string, unknown> };
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
    /** With a key file and the agent API: calls relayed (NEP-366), Euthyna pays the gas. */
    private readonly relayed?: { keyPair: KeyPair; rpcUrl: string; relay: DelegateRelay },
  ) {}

  static async connect(input: {
    networkId: string;
    rpcUrl: string;
    accountId: string;
    vaultAccountId: string;
    role: string;
    chainId: number;
    relay?: DelegateRelay | undefined;
  } & ({ privateKey: string; signer?: undefined } | { signer: AgentNearSigner; privateKey?: undefined })): Promise<NearVaultGateway> {
    let near: Near;
    if (input.signer) {
      // The key lives in euthyna-signer; this process only gets signatures.
      near = new Near({ networkId: input.networkId, nodeUrl: input.rpcUrl, signer: input.signer as never });
    } else {
      const keyStore = new keyStores.InMemoryKeyStore();
      await keyStore.setKey(
        input.networkId,
        input.accountId,
        KeyPair.fromString(input.privateKey as `ed25519:${string}`),
      );
      near = new Near({ networkId: input.networkId, nodeUrl: input.rpcUrl, keyStore });
    }
    return new NearVaultGateway(
      await near.account(input.accountId),
      input.vaultAccountId,
      input.role,
      input.chainId,
      input.relay && input.privateKey
        ? { keyPair: KeyPair.fromString(input.privateKey as `ed25519:${string}`), rpcUrl: input.rpcUrl, relay: input.relay }
        : undefined,
    );
  }

  async prepare(intent: PaymentIntent): Promise<PreparedOperation> {
    return this.prepareRequest(omniRolesPaymentRequest(intent, this.chainId));
  }

  async prepareRequest(request: OmniRolesOperationRequest, approval?: TokenApproval): Promise<PreparedOperation> {
    const outcome = approval
      ? await this.call("prepare_with_approval", { role: this.role, request, approval }, AGENT_GAS.prepareWithApproval)
      : await this.call("prepare", { role: this.role, request }, AGENT_GAS.prepare);
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

  async authorize(opId: number[], approval: GuardApproval | null): Promise<string> {
    const outcome = await this.call("authorize", { op_id: opId, approval }, AGENT_GAS.authorize);
    return outcome.transaction_outcome.id;
  }

  async cancelPrepared(opId: number[]): Promise<string> {
    const outcome = await this.call("cancel_prepared", { op_id: opId }, AGENT_GAS.prepare);
    return outcome.transaction_outcome.id;
  }

  async cancelNonce(opId: number[]): Promise<string> {
    const outcome = await this.call("cancel_nonce", {
      op_id: opId,
    }, AGENT_GAS.authorize);
    return outcome.transaction_outcome.id;
  }

  async renounceRole(): Promise<string> {
    const outcome = await this.call("renounce_role", { role: this.role }, AGENT_GAS.prepare);
    return outcome.transaction_outcome.id;
  }

  async view<T>(methodName: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.account.viewFunction({ contractId: this.vaultAccountId, methodName, args }) as Promise<T>;
  }
  async action(methodName: string, args: Record<string, unknown>, gas = "70000000000000"): Promise<string> {
    const result = await this.call(methodName, args, gas);
    return result.transaction_outcome.id;
  }
  identity() { return { member: this.account.accountId, role: this.role, chain_id: this.chainId }; }

  private async call(methodName: string, args: Record<string, unknown>, gas: string) {
    if (this.relayed) {
      const outcome = await relayedCall({
        ...this.relayed, senderId: this.account.accountId, receiverId: this.vaultAccountId, methodName, args, gas: BigInt(gas),
      });
      if (outcome) return outcome as unknown as Awaited<ReturnType<Account["functionCall"]>>;
    }
    return this.account.functionCall({
      contractId: this.vaultAccountId,
      methodName,
      args,
      gas,
      attachedDeposit: "0",
    });
  }
}


export { OnchainAgentClient, publicRpc } from "./onchain.js";
export { relayedCall, callOutcome, type DelegateRelay, type RelayOutcome } from "./meta-tx.js";
export * from "./solana.js";
export * from "./market.js";
export * from "./sealed-orders.js";
