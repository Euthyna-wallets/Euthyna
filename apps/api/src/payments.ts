import type { PrismaClient } from "@euthyna/db";
import { bytesToHex, decodeFunctionData, encodeFunctionData, getAddress, type Hex } from "viem";
import { z } from "zod";

import {
  BaseGasEstimationError,
  gasQuoteView,
  type BaseGasQuote,
  type BaseGasQuoter,
} from "./base-gas.js";
import type { Guard, GuardResult } from "./guard.js";
import { evaluateOperation, type GuardContext } from "./registry.js";
import type { NearClient } from "./near.js";
import type { RegistryService } from "./registry-db.js";
import type { VaultOperation } from "./types.js";
import type { SponsoredApproval } from "./evm.js";


const erc20TransferAbi = [{
  type: "function",
  name: "transfer",
  stateMutability: "nonpayable",
  inputs: [
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ type: "bool" }],
}] as const;
const roleGasSchema = z.object({
  config: z.object({
    gas_limit: z.string().regex(/^\d+$/),
    max_fee_per_gas: z.string().regex(/^\d+$/),
    max_priority_fee_per_gas: z.string().regex(/^\d+$/),
  }),
});
const chainWalletSchema = z.object({
  address: z.array(z.number().int().min(0).max(255)).length(20).nullable(),
});
export type OperationStatus =
  | "Prepared"
  | "PossiblySigned"
  | "Queued"
  | "Broadcast"
  | "Confirmed"
  | "Failed"
  | "Vetoed"
  | "CancellationRequested"
  | "CancellationBroadcast"
  | "CancellationMined"
  | "Cancelled"
  | "Rejected"
  | "Reverted";

export interface PayResult {
  status: 200 | 202 | 422;
  body: Record<string, unknown>;
}

export class PaymentError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function opHex(opId: number[]): string {
  return bytesToHex(Uint8Array.from(opId));
}

function operationPayment(operation: VaultOperation): { recipient: string; amount: string } {
  const decoded = decodeFunctionData({
    abi: erc20TransferAbi,
    data: bytesToHex(Uint8Array.from(operation.request.calldata)),
  });
  if (decoded.functionName !== "transfer") {
    throw new PaymentError(422, "unrecognized_payment_calldata", "operation is not an ERC-20 transfer");
  }
  return { recipient: decoded.args[0].toLowerCase(), amount: decoded.args[1].toString() };
}

function containsPromptInjection(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  return [
    /ignore (all |your |the )?(previous |prior )?(rules|instructions)/,
    /override (the )?(system|policy|guard)/,
    /reveal (the )?(system prompt|secret|credentials)/,
    /pay (the )?attacker/,
  ].some((pattern) => pattern.test(normalized));
}

export function checkInvoice(request: { calldata: number[] }, invoice?: { text?: string | undefined; claimedRecipient?: string | undefined }) {
  if (containsPromptInjection(invoice?.text)) return { allowed: false, reason: "prompt_injection_detected" };
  if (invoice?.claimedRecipient) {
    try {
      const decoded = decodeFunctionData({ abi: erc20TransferAbi, data: bytesToHex(Uint8Array.from(request.calldata)) });
      if (String(decoded.args[0]).toLowerCase() !== invoice.claimedRecipient.toLowerCase()) return { allowed: false, reason: "invoice_recipient_mismatch" };
    } catch { return { allowed: false, reason: "invoice_recipient_mismatch" }; }
  }
  return { allowed: true, reason: null };
}

export class PaymentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly near: NearClient,
    private readonly guard: Guard,
    private readonly registry: RegistryService,
    private readonly gasEstimator: BaseGasQuoter,
  ) {}

  async gasQuote(
    organizationId: string,
    agent: { nearAccountId: string; vaultAccountId: string; role: string },
    input: { token: string; recipient: string; amount: string },
  ) {
    const treasury = await this.prisma.treasury.findFirst({
      where: { organizationId, status: "active" },
      orderBy: { createdAt: "desc" },
    });
    if (!treasury) throw new PaymentError(409, "treasury_missing", "active treasury not found");
    const [rawRole, rawWallet] = await Promise.all([
      this.near.viewFunction<unknown>(agent.vaultAccountId, "get_role", { role: agent.role }),
      this.near.viewFunction<unknown>(agent.vaultAccountId, "get_wallet", { chain_id: treasury.baseChainId }),
    ]);
    const role = roleGasSchema.parse(rawRole).config;
    const wallet = chainWalletSchema.parse(rawWallet);
    if (!wallet.address) {
      throw new PaymentError(409, "wallet_address_missing", "ACME Base wallet is not derived");
    }
    const walletAddress = getAddress(bytesToHex(Uint8Array.from(wallet.address)));
    const token = getAddress(input.token);
    const recipient = getAddress(input.recipient);
    const transferData = encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [recipient, BigInt(input.amount)],
    });
    let quote: BaseGasQuote;
    try {
      quote = await this.gasEstimator.quote({
        from: walletAddress,
        to: token,
        data: transferData,
      });
    } catch (error) {
      const message = error instanceof BaseGasEstimationError ? error.message : String(error);
      throw new PaymentError(422, "gas_estimation_failed", message);
    }
    if (
      quote.gasLimit > BigInt(role.gas_limit) ||
      quote.maxFeePerGas > BigInt(role.max_fee_per_gas) ||
      quote.maxPriorityFeePerGas > BigInt(role.max_priority_fee_per_gas)
    ) {
      throw new PaymentError(422, "gas_quote_above_mandate", "dynamic Base gas quote exceeds the governed mandate caps");
    }
    return {
      gas: gasQuoteView(quote),
      warnings: quote.sufficientBalance
        ? []
        : [`ACME wallet ${walletAddress} needs ${quote.requiredBalance} wei but holds ${quote.senderBalance} wei`],
    };
  }

  async pay(
    organizationId: string,
    agent: { agentId: string; nearAccountId: string; vaultAccountId: string; role: string },
    opId: number[],
    invoice?: { text?: string | undefined; claimedRecipient?: string | undefined },
  ): Promise<PayResult> {
    const operation = await this.near.getOperation(agent.vaultAccountId, opId);
    if (operation.member !== agent.nearAccountId) {
      throw new PaymentError(403, "agent_mismatch", "operation belongs to another member");
    }
    if (operation.state !== "Prepared") {
      throw new PaymentError(422, "not_prepared", `operation state is ${operation.state}`);
    }
    const existingVisa = await this.prisma.paymentVisa.findUnique({
      where: { organizationId_opId: { organizationId, opId: opHex(opId) } },
    });
    if (existingVisa) return { status: 200, body: { visa: existingVisa.visa, signature: existingVisa.signature } };
    const refuse = async (code: string, reasons: string[]): Promise<PayResult> => {
      // No human escalation: the request is refused and shows up in Activity with its reason.
      await this.upsertOperation(organizationId, agent.agentId, operation, "Rejected");
      await this.prisma.auditLog.create({
        data: {
          organizationId,
          actorType: "agent",
          actorId: agent.agentId,
          action: "operation.refused",
          targetType: "operation",
          targetId: operation.request.reference,
          metadata: {
            reason: `GUARD:${code}:${reasons.join("; ")}`,
            role: operation.role,
            target: bytesToHex(Uint8Array.from(operation.request.target)),
            value: operation.request.value,
            calldata: bytesToHex(Uint8Array.from(operation.request.calldata.slice(0, 2048))),
          },
        },
      });
      return { status: 422, body: { error: code, message: reasons.join("; "), reasons } };
    };

    if (containsPromptInjection(invoice?.text)) {
      return refuse("prompt_injection_detected", ["the invoice contains instruction-like text"]);
    }
    if (await this.registry.isConsumed(organizationId, operation.request.reference)) {
      return refuse("reference_consumed", [`reference ${operation.request.reference} was already paid`]);
    }
    const claimedRecipient = invoice?.claimedRecipient?.toLowerCase();
    if (claimedRecipient) {
      const payment = operationPayment(operation);
      if (claimedRecipient !== payment.recipient) {
        return refuse("invoice_recipient_mismatch", ["the invoice's payment details differ from the recipient the agent prepared"]);
      }
    }
    const context: GuardContext = {
      suppliers: await this.registry.activeSupplierWallets(organizationId, operation.transaction.chain_id),
      companyWallet: await this.companyWallet(agent.vaultAccountId, operation.transaction.chain_id),
    };
    const sponsoredView = await this.near.viewFunction<{ deadline: number; approval?: SponsoredApproval | null } | null>(agent.vaultAccountId, "get_sponsored_operation", { op_id: opId }).catch(() => null);
    const sponsored = sponsoredView && context.companyWallet ? { wallet: context.companyWallet, deadline: BigInt(sponsoredView.deadline), approval: sponsoredView.approval ?? null } : null;
    const result: GuardResult = await this.guard.approve(operation, context, sponsored);
    if (result.decision === "refuse") return refuse("guard_refused", result.reasons);
    await this.upsertOperation(organizationId, agent.agentId, operation);
    const stored = await this.storeVisa(
      organizationId,
      opHex(opId),
      operation.request.reference,
      result.approval.visa as unknown as object,
      result.approval.signature,
    );
    return { status: 200, body: { visa: stored.visa, signature: stored.signature } };
  }

  /**
   * What the Guard would answer for a request, without preparing or signing
   * anything: lets an agent check before paying. The invoice checks need the
   * invoice and only run on a real payment.
   */
  async preview(
    organizationId: string,
    agent: { vaultAccountId: string },
    request: { chain_id: number; target: number[]; calldata: number[]; reference: string },
  ): Promise<{ code: string; reasons: string[] } | null> {
    if (request.reference && await this.registry.isConsumed(organizationId, request.reference)) {
      return { code: "reference_consumed", reasons: [`reference ${request.reference} was already paid`] };
    }
    const decision = evaluateOperation({
      suppliers: await this.registry.activeSupplierWallets(organizationId, request.chain_id),
      companyWallet: await this.companyWallet(agent.vaultAccountId, request.chain_id),
    }, { request } as unknown as VaultOperation);
    return decision.decision === "refuse" ? { code: "guard_refused", reasons: decision.reasons } : null;
  }

  /** Recipients the Guard accepts on a chain: the registered suppliers and the company wallet. */
  async recipients(organizationId: string, agent: { vaultAccountId: string }, chainId: number) {
    const suppliers = await this.registry.activeSupplierWallets(organizationId, chainId);
    return {
      companyWallet: await this.companyWallet(agent.vaultAccountId, chainId).catch(() => null),
      suppliers: suppliers.map((supplier) => ({ name: supplier.name, address: getAddress(supplier.address) })),
    };
  }

  private async companyWallet(vaultAccountId: string, chainId: number): Promise<`0x${string}` | null> {
    const wallet = chainWalletSchema.parse(await this.near.viewFunction<unknown>(vaultAccountId, "get_wallet", { chain_id: chainId }));
    return wallet.address ? getAddress(bytesToHex(Uint8Array.from(wallet.address))) : null;
  }

  async getOperation(organizationId: string, agentId: string, opId: number[]): Promise<Record<string, unknown>> {
    const hex = opHex(opId);
    const stored = await this.prisma.operation.findUnique({
      where: { organizationId_opId: { organizationId, opId: hex } },
    });
    if (stored && stored.agentId !== agentId) throw new PaymentError(403, "agent_mismatch", "operation belongs to another agent");
    const visa = await this.prisma.paymentVisa.findUnique({
      where: { organizationId_opId: { organizationId, opId: hex } },
    });
    const treasury = await this.prisma.treasury.findUnique({
      where: { organizationId_environment: { organizationId, environment: "uat" } },
    });
    let vaultState: string | null = null;
    if (treasury) {
      try {
        const onChain = await this.near.viewFunction<{ state?: string }>(treasury.vaultAccountId, "get_operation", {
          op_id: opId,
        });
        vaultState = onChain?.state ?? null;
      } catch {
        vaultState = null;
      }
    }
    const status = this.mergeStatus(stored?.state ?? vaultState, visa !== null);
    return {
      opId: hex,
      status,
      vaultState,
      visa: visa ? { visa: visa.visa, signature: visa.signature } : null,
      txHash: stored?.txHash ?? null,
      lastError: stored?.lastError ?? null,
    };
  }

  async recordAuthorization(
    organizationId: string,
    agent: { agentId: string; nearAccountId: string; vaultAccountId: string },
    opId: number[],
    nearTransactionHash: string,
  ): Promise<Record<string, unknown>> {
    const hex = opHex(opId);
    const stored = await this.prisma.operation.findUnique({
      where: { organizationId_opId: { organizationId, opId: hex } },
    });
    if (!stored) throw new PaymentError(404, "operation_not_found", "operation must be registered before authorization");
    if (stored.agentId !== agent.agentId) {
      throw new PaymentError(403, "agent_mismatch", "operation belongs to another agent");
    }
    if (stored.nearAuthorizationTxHash && stored.nearAuthorizationTxHash !== nearTransactionHash) {
      throw new PaymentError(409, "authorization_tx_conflict", "a different authorization transaction is already registered");
    }
    const operation = await this.near.getOperation(agent.vaultAccountId, opId);
    if (operation.member !== agent.nearAccountId) {
      throw new PaymentError(403, "agent_mismatch", "OmniRoles operation belongs to another member");
    }
    if (operation.state !== "Queued" && operation.state !== "PossiblySigned" && operation.state !== "Confirmed") {
      throw new PaymentError(422, "authorization_not_final", `operation state is ${operation.state}`);
    }
    const updated = await this.prisma.operation.update({
      where: { organizationId_opId: { organizationId, opId: hex } },
      data: {
        nearAuthorizationTxHash: nearTransactionHash,
        state: operation.state,
        nextAttemptAt: new Date(),
        lastError: null,
      },
    });
    return {
      opId: hex,
      nearTransactionHash: updated.nearAuthorizationTxHash,
      state: updated.state,
    };
  }

  async recordCancellation(
    organizationId: string,
    agent: { agentId: string; nearAccountId: string; vaultAccountId: string },
    opId: number[],
    nearTransactionHash: string,
  ): Promise<Record<string, unknown>> {
    const hex = opHex(opId);
    const stored = await this.prisma.operation.findUnique({
      where: { organizationId_opId: { organizationId, opId: hex } },
    });
    if (!stored) throw new PaymentError(404, "operation_not_found", "operation must be registered before cancellation");
    if (stored.agentId !== agent.agentId) {
      throw new PaymentError(403, "agent_mismatch", "operation belongs to another agent");
    }
    if (stored.nearCancellationTxHash && stored.nearCancellationTxHash !== nearTransactionHash) {
      throw new PaymentError(409, "cancellation_tx_conflict", "a different cancellation transaction is already registered");
    }
    const operation = await this.near.getOperation(agent.vaultAccountId, opId);
    if (operation.member !== agent.nearAccountId) {
      throw new PaymentError(403, "agent_mismatch", "OmniRoles operation belongs to another member");
    }
    if (operation.state !== "PossiblySigned" || !operation.cancellation) {
      throw new PaymentError(422, "cancellation_not_final", "Vault has no finalized cancellation request");
    }
    const updated = await this.prisma.operation.update({
      where: { organizationId_opId: { organizationId, opId: hex } },
      data: {
        nearCancellationTxHash: nearTransactionHash,
        state: "CancellationRequested",
        cancellationRequestedAt: new Date(),
        nextAttemptAt: new Date(),
        lastError: null,
      },
    });
    return {
      opId: hex,
      nearTransactionHash: updated.nearCancellationTxHash,
      state: updated.state,
    };
  }

  private async storeVisa(
    organizationId: string,
    opId: string,
    reference: string,
    visa: object,
    signature: string,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.paymentVisa.findUnique({
          where: { organizationId_opId: { organizationId, opId } },
        });
        if (existing) return existing;
        await tx.consumedReference.create({ data: { organizationId, reference, opId } });
        return tx.paymentVisa.create({ data: { organizationId, opId, visa, signature } });
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        const existing = await this.prisma.paymentVisa.findUnique({
          where: { organizationId_opId: { organizationId, opId } },
        });
        if (existing) return existing;
        throw new PaymentError(422, "reference_consumed", "this reference is already consumed");
      }
      throw error;
    }
  }

  private mergeStatus(stored: string | null | undefined, hasVisa: boolean): OperationStatus {
    if (stored === "Rejected") return "Rejected";
    if (stored === "Confirmed") return "Confirmed";
    if (stored === "Cancelled") return "Cancelled";
    if (stored === "Reverted") return "Reverted";
    if (stored === "Broadcast") return "Broadcast";
    if (stored === "PossiblySigned" || hasVisa) return "PossiblySigned";
    return (stored as OperationStatus | undefined) ?? "Prepared";
  }

  private async upsertOperation(organizationId: string, agentId: string, operation: VaultOperation, state = "Prepared") {
    const data = {
      organizationId,
      opId: opHex(operation.op_id),
      agentId,
      reference: operation.request.reference,
      state,
      txDigest: bytesToHex(Uint8Array.from(operation.tx_digest)),
      evmNonce: BigInt(operation.evm_nonce),
      amount: operation.request.allowance_amount,
    };
    await this.prisma.operation.upsert({
      where: { organizationId_opId: { organizationId, opId: data.opId } },
      update: { state: data.state },
      create: data,
    });
  }
}

