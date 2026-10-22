import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@mandateos/db";
import { hexToBytes, type Hex } from "viem";

import { onChainAgentEvmAddress } from "./agent-chain.js";
import type { Guard } from "./guard.js";
import { extractMpcSignatures, type NearTransactionStatus } from "./near.js";
import type { MpcSignature, VaultOperation } from "./types.js";

const ACTIVE_STATES = [
  "Prepared",
  "Escalated",
  "Rejected",
  "PossiblySigned",
  "Broadcast",
  "CancellationRequested",
  "CancellationBroadcast",
  "CancellationMined",
  "CancellationReverted",
];

export interface WorkerOperationRecord {
  organizationId: string;
  opId: string;
  agentId: string;
  agentNearAccountId: string;
  agentEvmAddress: string | null;
  vaultAccountId: string;
  reference: string;
  state: string;
  txHash: string | null;
  cancellationTxHash: string | null;
  nearAuthorizationTxHash: string | null;
  nearCancellationTxHash: string | null;
  receiptBlock: bigint | null;
  broadcastAt: Date | null;
  cancellationRequestedAt: Date | null;
  cancellationBroadcastAt: Date | null;
  nextAttemptAt: Date | null;
  lastError: string | null;
  attempts: number;
}

export interface WorkerOperationUpdate {
  state?: string;
  txHash?: string | null;
  cancellationTxHash?: string | null;
  nearCancellationTxHash?: string | null;
  receiptBlock?: bigint | null;
  reportNonce?: bigint | null;
  broadcastAt?: Date | null;
  cancellationRequestedAt?: Date | null;
  cancellationBroadcastAt?: Date | null;
  revertedAt?: Date | null;
  lastAttemptAt?: Date;
  nextAttemptAt?: Date | null;
  attempts?: number;
  lastError?: string | null;
}

export interface WorkerStore {
  acquireLease(now: Date, leaseMs: number): Promise<boolean>;
  listReady(now: Date): Promise<WorkerOperationRecord[]>;
  update(operation: WorkerOperationRecord, data: WorkerOperationUpdate): Promise<void>;
  releaseReference(operation: WorkerOperationRecord, terminalState: "Cancelled" | "Expired"): Promise<void>;
  syncAgentEvmAddress(operation: WorkerOperationRecord, evmAddress: string): Promise<void>;
}
export interface GovernanceJobRunner {
  tick(): Promise<number>;
}


export interface WorkerNearGateway {
  getOperation(vaultAccountId: string, opId: number[]): Promise<VaultOperation>;
  getAccount(accountId: string): Promise<{ amount: string }>;
  currentBlockHeight(): Promise<number>;
  transactionStatus(txHash: string, senderAccountId: string): Promise<NearTransactionStatus>;
  submitSignature(vaultAccountId: string, opId: number[], signature: MpcSignature): Promise<string>;
  reportStatus(vaultAccountId: string, signedReport: unknown, mpcSignature?: MpcSignature): Promise<string>;
  expireOperation(vaultAccountId: string, opId: number[]): Promise<string>;
  cancelNonce(
    vaultAccountId: string,
    opId: number[],
    gasLimit: string,
    maxFeePerGas: string,
    maxPriorityFeePerGas: string,
  ): Promise<string>;
  viewFunction<T>(accountId: string, methodName: string, args?: Record<string, unknown>): Promise<T>;
}

export interface WorkerBaseGateway {
  rawTransactionHash(rawTransaction: number[] | null): Hex;
  broadcastRaw(rawTransaction: number[] | null): Promise<Hex>;
  receipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint } | null>;
  blockNumber(): Promise<bigint>;
}

export interface WorkerConfig {
  pollIntervalMs: number;
  confirmations: number;
  leaseMs: number;
  stuckBlocks: number;
  broadcastTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  cancellationSenderAccountId: string;
  agentGasLowYocto: string;
}

function opBytes(opId: string): number[] {
  return Array.from(hexToBytes(opId as Hex));
}

function nextRetry(config: WorkerConfig, attempts: number, now: Date): Date {
  const delay = Math.min(config.retryBaseMs * (2 ** Math.min(attempts, 8)), config.retryMaxMs);
  return new Date(now.getTime() + delay);
}

function bumpedFee(value: bigint): bigint {
  return value + (value / 8n > 0n ? value / 8n : 1n);
}

export class PrismaWorkerStore implements WorkerStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly holder: string = randomUUID(),
    private readonly leaseName: string = "payment-worker",
  ) {}

  async acquireLease(now: Date, leaseMs: number): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + leaseMs);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const renewed = await transaction.workerLease.updateMany({
          where: {
            name: this.leaseName,
            OR: [{ holder: this.holder }, { expiresAt: { lte: now } }],
          },
          data: { holder: this.holder, expiresAt },
        });
        if (renewed.count === 1) return true;
        await transaction.workerLease.create({
          data: { name: this.leaseName, holder: this.holder, expiresAt },
        });
        return true;
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "P2002" || error.code === "P2034")
      ) {
        return false;
      }
      throw error;
    }
  }

  async listReady(now: Date): Promise<WorkerOperationRecord[]> {
    const operations = await this.prisma.operation.findMany({
      where: {
        state: { in: ACTIVE_STATES },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      include: {
        agent: { select: { nearAccountId: true, vaultAccountId: true, evmAddress: true } },
      },
      orderBy: { updatedAt: "asc" },
      take: 100,
    });
    return operations.map((operation) => ({
      organizationId: operation.organizationId,
      opId: operation.opId,
      agentId: operation.agentId,
      agentNearAccountId: operation.agent.nearAccountId,
      agentEvmAddress: operation.agent.evmAddress,
      vaultAccountId: operation.agent.vaultAccountId,
      reference: operation.reference,
      state: operation.state,
      txHash: operation.txHash,
      cancellationTxHash: operation.cancellationTxHash,
      nearAuthorizationTxHash: operation.nearAuthorizationTxHash,
      nearCancellationTxHash: operation.nearCancellationTxHash,
      receiptBlock: operation.receiptBlock,
      broadcastAt: operation.broadcastAt,
      cancellationRequestedAt: operation.cancellationRequestedAt,
      cancellationBroadcastAt: operation.cancellationBroadcastAt,
      nextAttemptAt: operation.nextAttemptAt,
      lastError: operation.lastError,
      attempts: operation.attempts,
    }));
  }

  async update(operation: WorkerOperationRecord, data: WorkerOperationUpdate): Promise<void> {
    await this.prisma.operation.update({
      where: {
        organizationId_opId: {
          organizationId: operation.organizationId,
          opId: operation.opId,
        },
      },
      data: data as Prisma.OperationUpdateInput,
    });
  }


  async syncAgentEvmAddress(operation: WorkerOperationRecord, evmAddress: string): Promise<void> {
    await this.prisma.agent.updateMany({
      where: { id: operation.agentId, organizationId: operation.organizationId },
      data: { evmAddress },
    });
  }
  async releaseReference(
    operation: WorkerOperationRecord,
    terminalState: "Cancelled" | "Expired",
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.operation.update({
        where: {
          organizationId_opId: {
            organizationId: operation.organizationId,
            opId: operation.opId,
          },
        },
        data: {
          state: terminalState,
          lastError: null,
          nextAttemptAt: null,
        },
      }),
      this.prisma.consumedReference.deleteMany({
        where: {
          organizationId: operation.organizationId,
          reference: operation.reference,
          opId: operation.opId,
        },
      }),
    ]);
  }
}

export class OperationWorker {
  constructor(
    private readonly store: WorkerStore,
    private readonly near: WorkerNearGateway,
    private readonly base: WorkerBaseGateway,
    private readonly guard: Pick<Guard, "confirmationReport">,
    private readonly config: WorkerConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly governance?: GovernanceJobRunner,
  ) {}

  async tick(): Promise<{ leased: boolean; processed: number }> {
    const now = this.now();
    if (!(await this.store.acquireLease(now, this.config.leaseMs))) {
      return { leased: false, processed: 0 };
    }
    const operations = await this.store.listReady(now);
    let processed = 0;
    if (operations.length > 0) {
      const blockHeight = await this.near.currentBlockHeight();
      for (const operation of operations) {
        if (!(await this.store.acquireLease(this.now(), this.config.leaseMs))) break;
        try {
          await this.process(operation, blockHeight);
        } catch (error) {
          const attempts = operation.attempts + 1;
          const message = error instanceof Error ? error.message : String(error);
          await this.store.update(operation, {
            attempts,
            lastAttemptAt: this.now(),
            nextAttemptAt: nextRetry(this.config, attempts, this.now()),
            lastError: message,
          });
        }
        processed += 1;
      }
    }
    if (this.governance && await this.store.acquireLease(this.now(), this.config.leaseMs)) {
      processed += await this.governance.tick();
    }
    return { leased: true, processed };
  }

  private async process(record: WorkerOperationRecord, blockHeight: number): Promise<void> {
    const id = opBytes(record.opId);
    let operation = await this.near.getOperation(record.vaultAccountId, id);
    const chainAgent = await this.near.viewFunction<unknown>(record.vaultAccountId, "get_agent", {
      agent: record.agentNearAccountId,
    });
    const derivedAddress = onChainAgentEvmAddress(chainAgent);
    if (derivedAddress && derivedAddress !== record.agentEvmAddress) {
      await this.store.syncAgentEvmAddress(record, derivedAddress);
    }
    try {
      const agentAccount = await this.near.getAccount(record.agentNearAccountId);
      if (BigInt(agentAccount.amount) < BigInt(this.config.agentGasLowYocto)) {
        console.warn(JSON.stringify({
          event: "agent.gas_balance_low",
          agentId: record.agentId,
          nearAccountId: record.agentNearAccountId,
          balanceYocto: agentAccount.amount,
          thresholdYocto: this.config.agentGasLowYocto,
          resolution: `send a simple NEAR transfer to ${record.agentNearAccountId}`,
        }));
      }
    } catch {
      // Balance alerting must not block payment recovery.
    }
    if (operation.state === "Confirmed") {
      const txHash = operation.signed_transaction
        ? this.base.rawTransactionHash(operation.signed_transaction)
        : record.txHash;
      const receipt = txHash ? await this.base.receipt(txHash as Hex) : null;
      await this.store.update(record, {
        state: "Confirmed",
        txHash,
        receiptBlock: receipt?.blockNumber ?? record.receiptBlock,
        lastError: null,
        nextAttemptAt: null,
      });
      return;
    }
    if (operation.state === "Cancelled") {
      const cancellationTxHash = operation.cancellation?.signed_transaction
        ? this.base.rawTransactionHash(operation.cancellation.signed_transaction)
        : record.cancellationTxHash;
      const receipt = cancellationTxHash ? await this.base.receipt(cancellationTxHash as Hex) : null;
      await this.store.update(record, {
        state: "Cancelled",
        cancellationTxHash,
        receiptBlock: receipt?.blockNumber ?? record.receiptBlock,
        lastError: null,
        nextAttemptAt: null,
      });
      await this.store.releaseReference(record, "Cancelled");
      return;
    }
    if (operation.state === "Expired") {
      await this.store.releaseReference(record, "Expired");
      return;
    }
    if (operation.state === "Prepared") {
      if (blockHeight > operation.expires_at_block) {
        await this.near.expireOperation(record.vaultAccountId, id);
        await this.store.releaseReference(record, "Expired");
      } else {
        await this.schedule(
          record,
          record.state === "Escalated" || record.state === "Rejected" ? record.state : "Prepared",
        );
      }
      return;
    }

    if (operation.state !== "PossiblySigned") {
      throw new Error(`unsupported Vault operation state ${operation.state}`);
    }

    if (!operation.signed_transaction && record.nearAuthorizationTxHash) {
      await this.recoverSignature(
        record,
        id,
        record.nearAuthorizationTxHash,
        operation.agent,
      );
      operation = await this.near.getOperation(record.vaultAccountId, id);
    }
    if (
      operation.cancellation &&
      !operation.cancellation.signed_transaction &&
      record.nearCancellationTxHash
    ) {
      await this.recoverSignature(
        record,
        id,
        record.nearCancellationTxHash,
        this.config.cancellationSenderAccountId,
      );
      operation = await this.near.getOperation(record.vaultAccountId, id);
    }

    if (operation.cancellation) {
      await this.processCancellation(record, operation, blockHeight);
      return;
    }
    if (operation.signed_transaction) {
      await this.processOriginal(record, operation, blockHeight);
      return;
    }

    if (this.isStuck(operation, blockHeight)) {
      await this.requestCancellation(record, operation, id);
      return;
    }
    await this.schedule(record, "PossiblySigned", record.nearAuthorizationTxHash ? null : "awaiting authorization transaction hash");
  }

  private async recoverSignature(
    record: WorkerOperationRecord,
    opId: number[],
    nearTransactionHash: string,
    senderAccountId: string,
  ): Promise<void> {
    const status = await this.near.transactionStatus(nearTransactionHash, senderAccountId);
    const candidates = extractMpcSignatures(status);
    if (candidates.length === 0) throw new Error(`no secp256k1 MPC response in ${nearTransactionHash}`);
    let lastError: unknown;
    for (const signature of candidates) {
      try {
        await this.near.submitSignature(record.vaultAccountId, opId, signature);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("MPC signature recovery failed");
  }

  private async processOriginal(
    record: WorkerOperationRecord,
    operation: VaultOperation,
    blockHeight: number,
  ): Promise<void> {
    const hash = this.base.rawTransactionHash(operation.signed_transaction);
    if (record.txHash && record.txHash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error(`stored Base hash ${record.txHash} differs from signed transaction ${hash}`);
    }
    const receipt = await this.base.receipt(hash);
    if (!receipt) {
      if (!record.txHash) {
        await this.base.broadcastRaw(operation.signed_transaction);
        await this.store.update(record, {
          state: "Broadcast",
          txHash: hash,
          broadcastAt: this.now(),
          lastAttemptAt: this.now(),
          nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
          lastError: null,
        });
        return;
      }
      if (
        record.broadcastAt &&
        this.now().getTime() - record.broadcastAt.getTime() >= this.config.broadcastTimeoutMs
      ) {
        await this.requestCancellation(record, operation, opBytes(record.opId));
        return;
      }
      await this.schedule(record, "Broadcast");
      return;
    }
    const baseBlock = await this.base.blockNumber();
    const depth = baseBlock >= receipt.blockNumber ? baseBlock - receipt.blockNumber + 1n : 0n;
    if (depth < BigInt(this.config.confirmations)) {
      await this.store.update(record, {
        state: "Broadcast",
        txHash: hash,
        receiptBlock: receipt.blockNumber,
        lastAttemptAt: this.now(),
        nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
        lastError: `waiting for Base confirmations ${depth}/${this.config.confirmations}`,
      });
      return;
    }
    if (receipt.status === "reverted") {
      await this.store.update(record, {
        state: "Reverted",
        txHash: hash,
        receiptBlock: receipt.blockNumber,
        revertedAt: this.now(),
        lastAttemptAt: this.now(),
        nextAttemptAt: null,
        lastError: `Base transaction ${hash} reverted; governance resolution required`,
      });
      return;
    }

    const signedReport = await this.guard.confirmationReport(operation, hash, receipt.blockNumber);
    await this.near.reportStatus(record.vaultAccountId, signedReport);
    await this.store.update(record, {
      state: "Confirmed",
      txHash: hash,
      receiptBlock: receipt.blockNumber,
      reportNonce: BigInt(signedReport.report?.report_nonce ?? 0),
      lastAttemptAt: this.now(),
      nextAttemptAt: null,
      lastError: null,
    });
  }

  private async processCancellation(
    record: WorkerOperationRecord,
    operation: VaultOperation,
    blockHeight: number,
  ): Promise<void> {
    const cancellation = operation.cancellation!;
    if (!cancellation.signed_transaction) {
      if (this.isStuck(operation, blockHeight)) {
        await this.requestCancellation(record, operation, opBytes(record.opId));
      } else {
        await this.schedule(record, "CancellationRequested");
      }
      return;
    }
    if (record.state === "CancellationReverted") {
      await this.requestCancellation(record, operation, opBytes(record.opId));
      return;
    }
    const hash = this.base.rawTransactionHash(cancellation.signed_transaction);
    if (record.cancellationTxHash && record.cancellationTxHash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error(`stored cancellation hash ${record.cancellationTxHash} differs from signed transaction ${hash}`);
    }
    const receipt = await this.base.receipt(hash);
    if (!receipt) {
      if (!record.cancellationTxHash) {
        await this.base.broadcastRaw(cancellation.signed_transaction);
        await this.store.update(record, {
          state: "CancellationBroadcast",
          cancellationTxHash: hash,
          cancellationBroadcastAt: this.now(),
          lastAttemptAt: this.now(),
          nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
          lastError: null,
        });
        return;
      }
      if (
        record.cancellationBroadcastAt &&
        this.now().getTime() - record.cancellationBroadcastAt.getTime() >= this.config.broadcastTimeoutMs
      ) {
        await this.requestCancellation(record, operation, opBytes(record.opId));
        return;
      }
      await this.schedule(record, "CancellationBroadcast");
      return;
    }
    const baseBlock = await this.base.blockNumber();
    const depth = baseBlock >= receipt.blockNumber ? baseBlock - receipt.blockNumber + 1n : 0n;
    if (depth < BigInt(this.config.confirmations)) {
      await this.store.update(record, {
        state: "CancellationBroadcast",
        cancellationTxHash: hash,
        receiptBlock: receipt.blockNumber,
        lastAttemptAt: this.now(),
        nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
        lastError: `waiting for Base confirmations ${depth}/${this.config.confirmations}`,
      });
      return;
    }
    if (receipt.status === "reverted") {
      await this.store.update(record, {
        state: "CancellationReverted",
        cancellationTxHash: hash,
        receiptBlock: receipt.blockNumber,
        lastAttemptAt: this.now(),
        nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
        lastError: `cancellation ${hash} reverted; requesting a higher-fee replacement`,
      });
      return;
    }
    await this.store.update(record, {
      state: "CancellationMined",
      cancellationTxHash: hash,
      receiptBlock: receipt.blockNumber,
      lastAttemptAt: this.now(),
      nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
      lastError: "cancellation mined; awaiting DAO confirm_cancellation",
    });
  }

  private async requestCancellation(
    record: WorkerOperationRecord,
    operation: VaultOperation,
    opId: number[],
  ): Promise<void> {
    const [paused, agent, role] = await Promise.all([
      this.near.viewFunction<boolean>(record.vaultAccountId, "is_paused"),
      this.near.viewFunction<{ active?: boolean }>(record.vaultAccountId, "get_agent", { agent: operation.agent }),
      this.near.viewFunction<{
        config: {
          gas_limit: string;
          max_fee_per_gas: string;
          max_priority_fee_per_gas: string;
          max_total_fee: string;
        };
      }>(record.vaultAccountId, "get_role", { role: operation.role }),
    ]);
    if (!paused && agent.active !== false) {
      await this.schedule(
        record,
        record.txHash ? "Broadcast" : "PossiblySigned",
        "stuck transaction requires Vault pause or agent revocation before worker cancellation",
      );
      return;
    }

    const previous = operation.cancellation?.transaction ?? operation.transaction;
    const maximumFee = BigInt(role.config.max_fee_per_gas);
    const maximumPriority = BigInt(role.config.max_priority_fee_per_gas);
    const gasLimit = 21_000n;
    if (gasLimit > BigInt(role.config.gas_limit)) {
      throw new Error("cancellation gas limit exceeds governed role limit");
    }
    const maxFee = bumpedFee(BigInt(previous.max_fee_per_gas));
    const maxPriority = bumpedFee(BigInt(previous.max_priority_fee_per_gas));
    if (maxFee > maximumFee || maxPriority > maximumPriority) {
      throw new Error("cancellation fee bump exceeds governed role limits");
    }
    if (maxFee * gasLimit > BigInt(role.config.max_total_fee)) {
      throw new Error("cancellation total fee exceeds governed role limit");
    }
    const nearTransactionHash = await this.near.cancelNonce(
      record.vaultAccountId,
      opId,
      gasLimit.toString(),
      maxFee.toString(),
      maxPriority.toString(),
    );
    await this.store.update(record, {
      state: "CancellationRequested",
      nearCancellationTxHash: nearTransactionHash,
      cancellationTxHash: null,
      cancellationRequestedAt: this.now(),
      cancellationBroadcastAt: null,
      lastAttemptAt: this.now(),
      nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
      lastError: null,
    });
  }

  private isStuck(operation: VaultOperation, blockHeight: number): boolean {
    const since = operation.cancellation?.requested_at_block ?? operation.possibly_signed_at_block;
    return since !== null && since !== undefined && blockHeight - since >= this.config.stuckBlocks;
  }

  private async schedule(record: WorkerOperationRecord, state: string, lastError: string | null = null): Promise<void> {
    await this.store.update(record, {
      state,
      lastAttemptAt: this.now(),
      nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
      lastError,
    });
  }
}
