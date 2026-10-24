import type { Prisma, PrismaClient } from "@mandateos/db";
import {
  getAddress,
  hexToBytes,
  type Address,
  type Hex,
} from "viem";

import type { GovernanceBaseGateway, GovernanceReceipt } from "./governance-base.js";
import {
  decodeZodiacBatchExpectation,
  type ZodiacBatchExpectation,
} from "./governance-calldata.js";
import type { Guard } from "./guard.js";
import { extractMpcSignatures, type NearTransactionStatus } from "./near.js";
import type { GovernanceOperation, MpcSignature } from "./types.js";

const ACTIVE_STATES = ["PossiblySigned", "Broadcast", "Queued", "Executing", "Reporting"];

export interface GovernanceTreasuryRecord {
  id: string;
  organizationId: string;
  relayAccountId: string;
  delayAddress: string;
  safeAddress: string;
  rolesAddress: string;
  baseChainId: number;
}

export interface GovernanceJobRecord extends GovernanceTreasuryRecord {
  opId: string;
  clientId: string;
  state: string;
  finalStatus: "Executed" | "Vetoed" | "Expired" | "Failed" | null;
  nearExecutionTxHash: string | null;
  nearExecutionSignerId: string | null;
  target: string;
  value: string;
  data: string;
  operation: number;
  txHash: string | null;
  receiptBlock: bigint | null;
  queueNonce: bigint | null;
  queueCreatedAt: bigint | null;
  executionScannedThroughBlock: bigint | null;
  vetoScannedThroughBlock: bigint | null;
  cooldownSeconds: bigint | null;
  expirationSeconds: bigint | null;
  executeRawTransaction: string | null;
  nextAttemptAt: Date | null;
  executeTxHash: string | null;
  executeReceiptBlock: bigint | null;
  attempts: number;
  lastError: string | null;
}

export interface GovernanceJobUpdate {
  state?: string;
  finalStatus?: "Executed" | "Vetoed" | "Expired" | "Failed" | null;
  txHash?: string | null;
  receiptBlock?: bigint | null;
  queueNonce?: bigint | null;
  queueCreatedAt?: bigint | null;
  cooldownSeconds?: bigint | null;
  expirationSeconds?: bigint | null;
  executionScannedThroughBlock?: bigint | null;
  vetoScannedThroughBlock?: bigint | null;
  executeRawTransaction?: string | null;
  executeTxHash?: string | null;
  executeReceiptBlock?: bigint | null;
  rolesVerification?: Prisma.InputJsonValue;
  reportNonce?: bigint | null;
  broadcastAt?: Date | null;
  queuedAt?: Date | null;
  executedAt?: Date | null;
  lastAttemptAt?: Date;
  nextAttemptAt?: Date | null;
  attempts?: number;
  lastError?: string | null;
}

export interface GovernanceStore {
  listTreasuries(): Promise<GovernanceTreasuryRecord[]>;
  upsertDiscovered(treasury: GovernanceTreasuryRecord, clientId: string, operation: GovernanceOperation): Promise<void>;
  listReady(now: Date): Promise<GovernanceJobRecord[]>;
  update(job: GovernanceJobRecord, update: GovernanceJobUpdate): Promise<void>;
}

export interface GovernanceNearGateway {
  viewFunction<T>(accountId: string, methodName: string, args?: Record<string, unknown>): Promise<T>;
  transactionStatus(txHash: string, senderAccountId: string): Promise<NearTransactionStatus>;
  submitSignature(relayAccountId: string, opId: number[], signature: MpcSignature): Promise<string>;
  reportStatus(relayAccountId: string, signedReport: unknown, mpcSignature?: MpcSignature): Promise<string>;
}

export interface GovernanceWorkerConfig {
  confirmations: number;
  pollIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  gasWalletMinimumWei: bigint;
}

function retryAt(config: GovernanceWorkerConfig, attempts: number, now: Date): Date {
  const delay = Math.min(config.retryBaseMs * (2 ** Math.min(attempts, 8)), config.retryMaxMs);
  return new Date(now.getTime() + delay);
}
function storedFinalStatus(value: string | null): GovernanceJobRecord["finalStatus"] {
  return value === "Executed" || value === "Vetoed" || value === "Expired" || value === "Failed"
    ? value
    : null;
}


function opBytes(opId: string): number[] {
  return Array.from(hexToBytes(opId as Hex));
}


export class PrismaGovernanceStore implements GovernanceStore {
  constructor(private readonly prisma: PrismaClient) {}

  async listTreasuries(): Promise<GovernanceTreasuryRecord[]> {
    return this.prisma.treasury.findMany({
      where: { status: "active" },
      select: {
        id: true,
        organizationId: true,
        relayAccountId: true,
        safeAddress: true,
        delayAddress: true,
        rolesAddress: true,
        baseChainId: true,
      },
    });
  }

  async upsertDiscovered(
    treasury: GovernanceTreasuryRecord,
    clientId: string,
    operation: GovernanceOperation,
  ): Promise<void> {
    const opId = `0x${Buffer.from(operation.op_id).toString("hex")}`;
    const existing = await this.prisma.governanceOperation.findUnique({
      where: { organizationId_opId: { organizationId: treasury.organizationId, opId } },
      select: { state: true },
    });
    if (existing && ["Executed", "Vetoed", "Expired", "Failed"].includes(existing.state)) return;
    await this.prisma.governanceOperation.upsert({
      where: { organizationId_opId: { organizationId: treasury.organizationId, opId } },
      create: {
        organizationId: treasury.organizationId,
        opId,
        treasuryId: treasury.id,
        relayAccountId: treasury.relayAccountId,
        clientId,
        state: operation.state,
        target: `0x${Buffer.from(operation.target).toString("hex")}`,
        value: operation.value,
        data: `0x${Buffer.from(operation.data).toString("hex")}`,
        operation: operation.operation,
        nextAttemptAt: new Date(),
      },
      update: {
        clientId,
        target: `0x${Buffer.from(operation.target).toString("hex")}`,
        value: operation.value,
        data: `0x${Buffer.from(operation.data).toString("hex")}`,
        operation: operation.operation,
      },
    });
  }

  async listReady(now: Date): Promise<GovernanceJobRecord[]> {
    const rows = await this.prisma.governanceOperation.findMany({
      where: {
        state: { in: ACTIVE_STATES },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      include: { treasury: true },
      orderBy: { updatedAt: "asc" },
      take: 10,
    });
    return rows.map((row) => ({
      id: row.treasury.id,
      organizationId: row.organizationId,
      relayAccountId: row.relayAccountId,
      delayAddress: row.treasury.delayAddress,
      safeAddress: row.treasury.safeAddress,
      rolesAddress: row.treasury.rolesAddress,
      baseChainId: row.treasury.baseChainId,
      opId: row.opId,
      clientId: row.clientId,
      state: row.state,
      finalStatus: storedFinalStatus(row.finalStatus),
      nearExecutionTxHash: row.nearExecutionTxHash,
      nearExecutionSignerId: row.nearExecutionSignerId,
      target: row.target,
      value: row.value,
      data: row.data,
      operation: row.operation,
      nextAttemptAt: row.nextAttemptAt,
      txHash: row.txHash,
      receiptBlock: row.receiptBlock,
      queueNonce: row.queueNonce,
      queueCreatedAt: row.queueCreatedAt,
      cooldownSeconds: row.cooldownSeconds,
      executionScannedThroughBlock: row.executionScannedThroughBlock,
      vetoScannedThroughBlock: row.vetoScannedThroughBlock,
      lastError: row.lastError,
      expirationSeconds: row.expirationSeconds,
      executeRawTransaction: row.executeRawTransaction,
      executeTxHash: row.executeTxHash,
      executeReceiptBlock: row.executeReceiptBlock,
      attempts: row.attempts,
    }));
  }

  async update(job: GovernanceJobRecord, update: GovernanceJobUpdate): Promise<void> {
    await this.prisma.governanceOperation.update({
      where: { organizationId_opId: { organizationId: job.organizationId, opId: job.opId } },
      data: update,
    });
  }
}


function assertRolesVerification(
  expectation: ZodiacBatchExpectation,
  verification: Awaited<ReturnType<GovernanceBaseGateway["verifyRoles"]>>,
  requireEvents: boolean,
): void {
  if (!verification.memberEnabled) throw new Error("Roles member assignment missing");
  const expected = expectation.allowance;
  const actual = verification.allowance;
  if (
    actual.balance !== expected.balance ||
    actual.maxRefill !== expected.maxRefill ||
    actual.refill !== expected.refill ||
    actual.period !== expected.period ||
    actual.timestamp !== expected.timestamp
  ) {
    throw new Error("Roles allowance state does not match the governed batch");
  }
  if (requireEvents) {
    const events = new Set(verification.events);
    for (const event of ["AssignRoles", "ScopeTarget", "ScopeFunction", "SetAllowance"]) {
      if (!events.has(event)) throw new Error(`Roles ${event} evidence missing`);
    }
  }
}

function maybeZodiacBatchExpectation(job: GovernanceJobRecord): ZodiacBatchExpectation | null {
  try {
    return decodeZodiacBatchExpectation({
      chainId: job.baseChainId,
      rolesAddress: job.rolesAddress,
      target: job.target,
      data: job.data as Hex,
      operation: job.operation,
    });
  } catch {
    return null;
  }
}

export class GovernanceWorker {
  private lastDiscoveryAt = 0;

  constructor(
    private readonly store: GovernanceStore,
    private readonly near: GovernanceNearGateway,
    private readonly base: GovernanceBaseGateway,
    private readonly guard: Pick<Guard, "relayStatusReport">,
    private readonly config: GovernanceWorkerConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async tick(): Promise<number> {
    let [job] = await this.store.listReady(this.now());
    if (!job && this.now().getTime() - this.lastDiscoveryAt >= 60_000) {
      await this.discover();
      this.lastDiscoveryAt = this.now().getTime();
      [job] = await this.store.listReady(this.now());
    }
    const balance = await this.base.gasWalletBalance();
    if (balance < this.config.gasWalletMinimumWei) {
      console.warn(JSON.stringify({
        event: "governance.gas_wallet_low",
        address: this.base.gasWalletAddress(),
        balanceWei: balance.toString(),
        thresholdWei: this.config.gasWalletMinimumWei.toString(),
      }));
    }
    if (!job) return 0;
    try {
      await this.process(job);
    } catch (error) {
      const attempts = job.attempts + 1;
      await this.store.update(job, {
        attempts,
        lastAttemptAt: this.now(),
        nextAttemptAt: retryAt(this.config, attempts, this.now()),
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
    return 1;
  }

  private async discover(): Promise<void> {
    for (const treasury of await this.store.listTreasuries()) {
      const opId = await this.near.viewFunction<number[] | null>(treasury.relayAccountId, "active_operation");
      if (!opId) continue;
      const [operation, clientId] = await Promise.all([
        this.near.viewFunction<GovernanceOperation | null>(treasury.relayAccountId, "get_operation", { op_id: opId }),
        this.near.viewFunction<string>(treasury.relayAccountId, "client_id"),
      ]);
      if (operation) await this.store.upsertDiscovered(treasury, clientId, operation);
    }
  }

  private async process(job: GovernanceJobRecord): Promise<void> {
    const id = opBytes(job.opId);
    if (job.state === "Reporting") {
      await this.reportFinal(job, id);
      return;
    }
    let operation: GovernanceOperation | null = null;
    let hash: Hex;
    if (job.state === "PossiblySigned" || job.state === "Broadcast") {
      operation = await this.near.viewFunction<GovernanceOperation | null>(
        job.relayAccountId,
        "get_operation",
        { op_id: id },
      );
      if (!operation) throw new Error("relay operation missing");
      if (operation.state === "Confirmed") {
        await this.store.update(job, {
          state: job.executeTxHash ? "Executed" : "Confirmed",
          ...(job.executeTxHash ? { executedAt: this.now() } : {}),
          nextAttemptAt: null,
          lastError: null,
        });
        return;
      }
      if (operation.state === "Cancelled") {
        await this.store.update(job, { state: "Vetoed", nextAttemptAt: null });
        return;
      }
      if (!operation.signed_transaction) {
        if (!job.nearExecutionTxHash || !job.nearExecutionSignerId) {
          await this.schedule(job, "PossiblySigned", "awaiting final DAO vote transaction hash");
          return;
        }
        await this.recoverSignature(job, id);
        operation = await this.near.viewFunction<GovernanceOperation | null>(
          job.relayAccountId,
          "get_operation",
          { op_id: id },
        );
        if (!operation?.signed_transaction) {
          await this.schedule(job, "PossiblySigned", "MPC signature is not available yet");
          return;
        }
      }
      hash = this.base.rawTransactionHash(operation.signed_transaction);
      if (job.txHash && job.txHash.toLowerCase() !== hash.toLowerCase()) {
        throw new Error("stored governance hash differs from relay signed transaction");
      }
    } else {
      if (!job.txHash) throw new Error("governance queue hash missing");
      hash = job.txHash as Hex;
    }
    const queueReceipt = await this.base.receipt(hash);
    if (!queueReceipt) {
      if (!operation?.signed_transaction) throw new Error("queued governance receipt unavailable");
      let entryNonce = job.queueNonce;
      if (entryNonce === null) {
        entryNonce = (await this.base.delayState(getAddress(job.delayAddress), 0n)).queueNonce;
        await this.store.update(job, {
          state: "Broadcast",
          txHash: hash,
          queueNonce: entryNonce,
          broadcastAt: this.now(),
          lastAttemptAt: this.now(),
          nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
          lastError: null,
        });
      }
      await this.base.broadcastRaw(operation.signed_transaction);
      if (job.queueNonce !== null) await this.schedule(job, "Broadcast");
      return;
    }
    const currentBlock = await this.base.blockNumber();
    const queueDepth = currentBlock >= queueReceipt.blockNumber ? currentBlock - queueReceipt.blockNumber + 1n : 0n;
    if (queueDepth < BigInt(this.config.confirmations)) {
      await this.store.update(job, {
        state: "Broadcast",
        txHash: hash,
        receiptBlock: queueReceipt.blockNumber,
        lastAttemptAt: this.now(),
        nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
        lastError: `waiting for Base confirmations ${queueDepth}/${this.config.confirmations}`,
      });
      return;
    }
    if (queueReceipt.status === "reverted") {
      await this.checkpointFinal(job, "Failed", {
        txHash: hash,
        receiptBlock: queueReceipt.blockNumber,
        lastError: `governance queue transaction ${hash} reverted`,
      });
      return;
    }

    const entryNonce = job.queueNonce;
    if (entryNonce === null) throw new Error("Delay queue nonce was not checkpointed before broadcast");
    const delay = getAddress(job.delayAddress);
    const operationInput = {
      to: getAddress(job.target),
      value: BigInt(job.value),
      data: job.data as Hex,
      operation: job.operation === 1 ? 1 as const : 0 as const,
    };
    const delayState = await this.base.delayState(delay, entryNonce);
    if (delayState.queueNonce <= entryNonce || delayState.createdAt === 0n) {
      await this.schedule(job, "Broadcast", "waiting for Delay queue entry");
      return;
    }
    const expectedEntryHash = this.base.expectedDelayHash(operationInput);
    if (delayState.entryHash.toLowerCase() !== expectedEntryHash.toLowerCase()) {
      throw new Error(`Delay entry hash ${delayState.entryHash} differs from expected ${expectedEntryHash}`);
    }
    const checkpointedExecuteReceipt = job.executeTxHash
      ? await this.base.receipt(job.executeTxHash as Hex)
      : null;
    const executionFromBlock = checkpointedExecuteReceipt?.status === "success"
      ? checkpointedExecuteReceipt.blockNumber
      : job.executionScannedThroughBlock === null
        ? queueReceipt.blockNumber
        : job.executionScannedThroughBlock + 1n;
    const executionScan = await this.base.findExecution({
      safe: getAddress(job.safeAddress),
      delay,
      ...operationInput,
      fromBlock: executionFromBlock,
    });
    const execution = executionScan.evidence;
    const executionScannedThroughBlock = executionScan.scannedThroughBlock >= executionFromBlock
      ? executionScan.scannedThroughBlock
      : job.executionScannedThroughBlock;
    if (execution) {
      const executionDepth = currentBlock >= execution.blockNumber
        ? currentBlock - execution.blockNumber + 1n
        : 0n;
      if (executionDepth < BigInt(this.config.confirmations)) {
        await this.store.update(job, {
          state: job.executeRawTransaction ? "Executing" : "Queued",
          executeTxHash: execution.transactionHash,
          executeReceiptBlock: execution.blockNumber,
          executionScannedThroughBlock,
          lastAttemptAt: this.now(),
          nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
          lastError: `waiting for execute confirmations ${executionDepth}/${this.config.confirmations}`,
        });
        return;
      }
      const rolesVerification = await this.verifyExecuted(job, execution.receipt, true);
      await this.checkpointFinal(job, "Executed", {
        txHash: hash,
        receiptBlock: queueReceipt.blockNumber,
        executeTxHash: execution.transactionHash,
        executeReceiptBlock: execution.blockNumber,
        rolesVerification,
        executedAt: this.now(),
      });
      return;
    }

    const expirationAt = delayState.createdAt + delayState.cooldown + delayState.expiration;
    const expired = delayState.expiration !== 0n && delayState.currentTimestamp > expirationAt;
    if (delayState.txNonce > entryNonce) {
      const vetoFromBlock = job.vetoScannedThroughBlock === null
        ? queueReceipt.blockNumber
        : job.vetoScannedThroughBlock + 1n;
      const vetoScan = await this.base.findVeto(delay, entryNonce, vetoFromBlock);
      const veto = vetoScan.evidence;
      const vetoScannedThroughBlock = vetoScan.scannedThroughBlock >= vetoFromBlock
        ? vetoScan.scannedThroughBlock
        : job.vetoScannedThroughBlock;
      if (veto) {
        const vetoDepth = currentBlock >= veto.blockNumber ? currentBlock - veto.blockNumber + 1n : 0n;
        if (vetoDepth < BigInt(this.config.confirmations)) {
          await this.store.update(job, {
            state: "Queued",
            executionScannedThroughBlock,
            vetoScannedThroughBlock,
            lastAttemptAt: this.now(),
            nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
            lastError: `waiting for veto confirmations ${vetoDepth}/${this.config.confirmations}`,
          });
          return;
        }
        await this.checkpointFinal(job, "Vetoed", {
          txHash: hash,
          receiptBlock: queueReceipt.blockNumber,
        });
        return;
      }
      await this.store.update(job, {
        executionScannedThroughBlock,
        vetoScannedThroughBlock,
      });
      if (expired) {
        await this.checkpointFinal(job, "Expired", {
          txHash: hash,
          receiptBlock: queueReceipt.blockNumber,
        });
        return;
      }
      throw new Error("Delay nonce advanced without matching execution or veto evidence");
    }

    await this.store.update(job, {
      state: job.executeRawTransaction ? "Executing" : "Queued",
      txHash: hash,
      receiptBlock: queueReceipt.blockNumber,
      queueCreatedAt: delayState.createdAt,
      cooldownSeconds: delayState.cooldown,
      expirationSeconds: delayState.expiration,
      executionScannedThroughBlock,
      ...(job.queueCreatedAt === null ? { queuedAt: this.now() } : {}),
      lastAttemptAt: this.now(),
      nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
      lastError: null,
    });

    if (expired) {
      await this.checkpointFinal(job, "Expired", {
        txHash: hash,
        receiptBlock: queueReceipt.blockNumber,
      });
      return;
    }
    if (delayState.currentTimestamp < delayState.createdAt + delayState.cooldown) {
      const remainingSeconds = delayState.createdAt + delayState.cooldown - delayState.currentTimestamp;
      const cooldownWaitMs = Number(remainingSeconds) * 1_000;
      await this.store.update(job, {
        state: "Queued",
        lastAttemptAt: this.now(),
        nextAttemptAt: new Date(this.now().getTime() + Math.min(cooldownWaitMs, this.config.pollIntervalMs)),
        lastError: null,
      });
      return;
    }

    if (!job.executeRawTransaction || !job.executeTxHash) {
      const prepared = await this.base.prepareExecuteNextTx({ delay, ...operationInput });
      await this.store.update(job, {
        state: "Executing",
        executeRawTransaction: prepared.rawTransaction,
        executeTxHash: prepared.hash,
        lastAttemptAt: this.now(),
        nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
        lastError: null,
      });
      return;
    }

    const executeHash = job.executeTxHash as Hex;
    const executeReceipt = checkpointedExecuteReceipt ?? await this.base.receipt(executeHash);
    if (!executeReceipt) {
      await this.base.broadcastRaw(job.executeRawTransaction as Hex);
      await this.schedule(job, "Executing");
      return;
    }
    const executeDepth = currentBlock >= executeReceipt.blockNumber ? currentBlock - executeReceipt.blockNumber + 1n : 0n;
    if (executeDepth < BigInt(this.config.confirmations)) {
      await this.store.update(job, {
        state: "Executing",
        executeReceiptBlock: executeReceipt.blockNumber,
        lastAttemptAt: this.now(),
        nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
        lastError: `waiting for execute confirmations ${executeDepth}/${this.config.confirmations}`,
      });
      return;
    }
    if (executeReceipt.status === "reverted") {
      await this.checkpointFinal(job, "Failed", {
        executeTxHash: executeHash,
        executeReceiptBlock: executeReceipt.blockNumber,
        lastError: `Delay executeNextTx ${executeHash} reverted`,
      });
      return;
    }

    throw new Error(
      `successful executeNextTx receipt ${executeHash} lacks matching Safe ExecutionFromModuleSuccess evidence`,
    );
  }

  private async verifyExecuted(
    job: GovernanceJobRecord,
    receipt: GovernanceReceipt | null,
    requireEvents: boolean,
  ): Promise<Prisma.InputJsonValue> {
    const expectation = maybeZodiacBatchExpectation(job);
    if (!expectation) return { mode: "receipt-only", delayEntryHashVerified: true };
    const verification = await this.base.verifyRoles({
      roles: getAddress(job.rolesAddress),
      member: expectation.member,
      allowanceKey: expectation.allowanceKey,
      receipt,
    });
    assertRolesVerification(expectation, verification, requireEvents);
    return {
      mode: "zodiac",
      member: expectation.member,
      allowanceKey: expectation.allowanceKey,
      events: verification.events,
      allowance: {
        refill: verification.allowance.refill.toString(),
        maxRefill: verification.allowance.maxRefill.toString(),
        period: verification.allowance.period.toString(),
        balance: verification.allowance.balance.toString(),
        timestamp: verification.allowance.timestamp.toString(),
      },
    };
  }

  private async checkpointFinal(
    job: GovernanceJobRecord,
    finalStatus: NonNullable<GovernanceJobRecord["finalStatus"]>,
    update: GovernanceJobUpdate = {},
  ): Promise<void> {
    await this.store.update(job, {
      state: "Reporting",
      finalStatus,
      ...update,
      lastAttemptAt: this.now(),
      nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
    });
  }

  private async reportFinal(job: GovernanceJobRecord, opId: number[]): Promise<void> {
    if (!job.finalStatus) throw new Error("relay final status missing");
    if (!job.txHash || job.receiptBlock === null) throw new Error("queue receipt checkpoint missing");
    const operation = await this.near.viewFunction<GovernanceOperation | null>(
      job.relayAccountId,
      "get_operation",
      { op_id: opId },
    );
    if (!operation) throw new Error("relay operation missing after finalization");
    const alreadyFinal =
      operation.state === job.finalStatus ||
      operation.state === "Confirmed";
    let reportNonce: bigint | null = null;
    if (!alreadyFinal) {
      const signedReport = await this.guard.relayStatusReport(
        job.clientId,
        operation,
        job.txHash as Hex,
        job.receiptBlock,
        job.finalStatus,
      );
      await this.near.reportStatus(job.relayAccountId, signedReport);
      reportNonce = BigInt(signedReport.report?.report_nonce ?? 0);
    }
    await this.store.update(job, {
      state: job.finalStatus,
      reportNonce,
      lastAttemptAt: this.now(),
      nextAttemptAt: null,
      lastError: job.finalStatus === "Failed" ? job.lastError : null,
    });
  }

  private async recoverSignature(job: GovernanceJobRecord, opId: number[]): Promise<void> {
    const status = await this.near.transactionStatus(job.nearExecutionTxHash!, job.nearExecutionSignerId!);
    const signatures = extractMpcSignatures(status);
    if (signatures.length === 0) throw new Error(`no secp256k1 MPC response in ${job.nearExecutionTxHash}`);
    let lastError: unknown;
    for (const signature of signatures) {
      try {
        await this.near.submitSignature(job.relayAccountId, opId, signature);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("relay MPC signature recovery failed");
  }

  private async schedule(job: GovernanceJobRecord, state: string, lastError: string | null = null): Promise<void> {
    await this.store.update(job, {
      state,
      lastAttemptAt: this.now(),
      nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
      lastError,
    });
  }

}
