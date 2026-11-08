import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@euthyna/db";
import { bytesToHex, hexToBytes, type Hex } from "viem";

import { onChainWalletEvmAddress } from "./agent-chain.js";
import type { Guard } from "./guard.js";
import { extractMpcSignatures, type NearTransactionStatus } from "./near.js";
import type { MpcSignature, VaultOperation } from "./types.js";


/** How often the worker looks in every vault for operations an agent left signed. */
const DISCOVER_EVERY_MS = 10 * 60_000;
/** How long a vault without a wallet on a chain is not asked again. */
const NO_WALLET_RECHECK_MS = 60 * 60_000;

const ACTIVE_STATES = [
  "Prepared",
  "Queued",
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
  agentId: string | null;
  agentNearAccountId: string | null;
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
  nearAuthorizationTxHash?: string | null;
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

/** A company vault the worker watches, and the chains its wallets act on. */
export interface WorkerVault {
  organizationId: string;
  vaultAccountId: string;
  chainIds: number[];
}

/** An operation signed on chain that the worker had no record of (an agent that called the vault itself). */
export interface AdoptedOperation {
  organizationId: string;
  vaultAccountId: string;
  opId: string;
  reference: string;
  txDigest: string;
  evmNonce: bigint;
  amount: string;
}

export interface WorkerStore {
  acquireLease(now: Date, leaseMs: number): Promise<boolean>;
  /** Vaults to scan for signed operations nobody recorded. Optional: without it, the worker only follows its records. */
  listVaults?(): Promise<WorkerVault[]>;
  /** Which of these operations already have a record. */
  tracked?(organizationId: string, opIds: string[]): Promise<Set<string>>;
  /** Records an operation found on chain; false when another worker recorded it first. */
  adopt?(operation: AdoptedOperation, now: Date): Promise<boolean>;
  listReady(now: Date): Promise<WorkerOperationRecord[]>;
  update(operation: WorkerOperationRecord, data: WorkerOperationUpdate): Promise<void>;
  releaseReference(operation: WorkerOperationRecord, terminalState: "Cancelled" | "Expired" | "Failed" | "Vetoed"): Promise<void>;
  syncAgentEvmAddress(operation: WorkerOperationRecord, evmAddress: string): Promise<void>;
}


export interface WorkerNearGateway {
  getOperation(vaultAccountId: string, opId: number[]): Promise<VaultOperation>;
  getAccount(accountId: string): Promise<{ amount: string }>;
  currentBlockTimestampNs(): Promise<bigint>;
  executeQueuedOperation(vaultAccountId: string, opId: number[]): Promise<string>;
  transactionStatus(txHash: string, senderAccountId: string): Promise<NearTransactionStatus>;
  submitSignature(vaultAccountId: string, opId: number[], signature: MpcSignature): Promise<string>;
  settle?(vaultAccountId: string, opId: number[], blockHash: Hex, cancellation?: boolean): Promise<string>;
  releaseUnconfirmed?(vaultAccountId: string, opId: number[]): Promise<string>;
  reportStatus(vaultAccountId: string, signedReport: unknown, mpcSignature?: MpcSignature): Promise<string>;
  expireOperation(vaultAccountId: string, opId: number[]): Promise<string>;
  cancelNonce(vaultAccountId: string, opId: number[]): Promise<string>;
  viewFunction<T>(accountId: string, methodName: string, args?: Record<string, unknown>): Promise<T>;
}

export interface WorkerBaseGateway {
  rawTransactionHash(rawTransaction: number[] | null): Hex;
  broadcastRaw(rawTransaction: number[] | null): Promise<Hex>;
  receipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint; blockHash?: Hex } | null>;
  blockNumber(): Promise<bigint>;
  finalizedBlockNumber(): Promise<bigint>;
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
  /** How often to scan the vaults for signed operations without a record (default one minute). */
  discoverIntervalMs?: number;
}

function opBytes(opId: string): number[] {
  return Array.from(hexToBytes(opId as Hex));
}

function nextRetry(config: WorkerConfig, attempts: number, now: Date): Date {
  const delay = Math.min(config.retryBaseMs * (2 ** Math.min(attempts, 8)), config.retryMaxMs);
  return new Date(now.getTime() + delay);
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

  async listVaults(): Promise<WorkerVault[]> {
    const treasuries = await this.prisma.treasury.findMany({
      where: { status: "active" },
      select: { organizationId: true, vaultAccountId: true, baseChainId: true },
    });
    return treasuries.map((treasury) => ({
      organizationId: treasury.organizationId,
      vaultAccountId: treasury.vaultAccountId,
      chainIds: [treasury.baseChainId],
    }));
  }

  async tracked(organizationId: string, opIds: string[]): Promise<Set<string>> {
    const rows = await this.prisma.operation.findMany({
      where: { organizationId, opId: { in: opIds } },
      select: { opId: true },
    });
    return new Set(rows.map((row) => row.opId));
  }

  async adopt(operation: AdoptedOperation, now: Date): Promise<boolean> {
    try {
      await this.prisma.operation.create({
        data: {
          organizationId: operation.organizationId,
          opId: operation.opId,
          agentId: null,
          vaultAccountId: operation.vaultAccountId,
          reference: operation.reference,
          state: "PossiblySigned",
          txDigest: operation.txDigest,
          evmNonce: operation.evmNonce,
          amount: operation.amount,
          nextAttemptAt: now,
        },
      });
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") return false;
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
      agentNearAccountId: operation.agent?.nearAccountId ?? null,
      agentEvmAddress: operation.agent?.evmAddress ?? null,
      vaultAccountId: operation.agent?.vaultAccountId ?? operation.vaultAccountId ?? "",
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
      where: { id: operation.agentId ?? "", organizationId: operation.organizationId },
      data: { evmAddress },
    });
  }
  async releaseReference(
    operation: WorkerOperationRecord,
    terminalState: "Cancelled" | "Expired" | "Failed" | "Vetoed",
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
  /** Gateway of the chain of the operation being processed (operations run one at a time). */
  private base: WorkerBaseGateway;

  constructor(
    private readonly store: WorkerStore,
    private readonly near: WorkerNearGateway,
    private readonly defaultChain: WorkerBaseGateway,
    private readonly guard: Pick<Guard, "confirmationReport" | "failureReport">,
    private readonly config: WorkerConfig,
    private readonly now: () => Date = () => new Date(),
    /** Other EVM chains the company wallet acts on (DAO-voted transactions). */
    private readonly chains: Record<number, WorkerBaseGateway> = {},
  ) {
    this.base = defaultChain;
  }

  async tick(): Promise<{ leased: boolean; processed: number; adopted: number }> {
    const now = this.now();
    if (!(await this.store.acquireLease(now, this.config.leaseMs))) {
      return { leased: false, processed: 0, adopted: 0 };
    }
    const adopted = await this.discover(now);
    const operations = await this.store.listReady(now);
    let processed = 0;
    if (operations.length > 0) {
      const blockTimestampNs = await this.near.currentBlockTimestampNs();
      for (const operation of operations) {
        if (!(await this.store.acquireLease(this.now(), this.config.leaseMs))) break;
        try {
          await this.process(operation, blockTimestampNs);
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
    return { leased: true, processed, adopted };
  }

  private lastDiscoveryAt = Number.NEGATIVE_INFINITY;
  private readonly noWalletUntil = new Map<string, number>();

  /**
   * Agents sign through the vault themselves; nothing guarantees they come back to settle. An
   * operation left signed keeps its budget reserved and a place in the wallet's queue (8 at most,
   * shared by every agent), and blocks the votes that touch its role. So the worker reads what each
   * vault holds in flight and takes over what it has no record of; `process` then settles it,
   * releases it or cancels its nonce like any other.
   */
  private async discover(now: Date): Promise<number> {
    const { listVaults, tracked, adopt } = this.store;
    if (!listVaults || !tracked || !adopt) return 0;
    // An abandoned operation waits minutes anyway (the agent left it): every 10 minutes is enough,
    // and keeps the RPC quota for the work that is due.
    if (now.getTime() - this.lastDiscoveryAt < (this.config.discoverIntervalMs ?? DISCOVER_EVERY_MS)) return 0;
    this.lastDiscoveryAt = now.getTime();
    let adopted = 0;
    for (const vault of await listVaults.call(this.store)) {
      try {
        const chainIds = [...new Set([...vault.chainIds, ...Object.keys(this.chains).map(Number)])];
        for (const chainId of chainIds) {
          // A vault without a wallet on a chain: asked again once an hour, not on every round.
          const walletKey = `${vault.vaultAccountId}:${chainId}`;
          if ((this.noWalletUntil.get(walletKey) ?? 0) > now.getTime()) continue;
          const wallet = await this.near.viewFunction<{ in_flight?: number[][] } | null>(vault.vaultAccountId, "get_wallet", { chain_id: chainId });
          if (!wallet) this.noWalletUntil.set(walletKey, now.getTime() + NO_WALLET_RECHECK_MS);
          const ids = (wallet?.in_flight ?? []).map((id) => bytesToHex(Uint8Array.from(id)));
          if (!ids.length) continue;
          const known = await tracked.call(this.store, vault.organizationId, ids);
          for (const opId of ids.filter((id) => !known.has(id))) {
            const operation = await this.near.getOperation(vault.vaultAccountId, opBytes(opId));
            if (operation.state !== "PossiblySigned") continue;
            const created = await adopt.call(this.store, {
              organizationId: vault.organizationId,
              vaultAccountId: vault.vaultAccountId,
              opId,
              reference: operation.request.reference,
              txDigest: bytesToHex(Uint8Array.from(operation.tx_digest)),
              evmNonce: BigInt(operation.evm_nonce),
              amount: operation.request.allowance_amount,
            }, now);
            if (created) {
              adopted += 1;
              console.log(JSON.stringify({ event: "worker.adopted", vault: vault.vaultAccountId, opId, member: operation.member, reference: operation.request.reference }));
            }
          }
        }
      } catch (error) {
        console.error(JSON.stringify({ event: "worker.discover_failed", vault: vault.vaultAccountId, message: error instanceof Error ? error.message : String(error) }));
      }
    }
    return adopted;
  }

  private async process(record: WorkerOperationRecord, blockTimestampNs: bigint): Promise<void> {
    const id = opBytes(record.opId);
    let operation = await this.near.getOperation(record.vaultAccountId, id);
    this.base = this.chains[operation.request.chain_id] ?? this.defaultChain;
    const chainWallet = await this.near.viewFunction<unknown>(record.vaultAccountId, "get_wallet", {
      chain_id: operation.request.chain_id,
    });
    const derivedAddress = onChainWalletEvmAddress(chainWallet);
    if (record.agentId && derivedAddress && derivedAddress !== record.agentEvmAddress) {
      await this.store.syncAgentEvmAddress(record, derivedAddress);
    }
    try {
      // DAO transactions have no agent account to keep funded.
      if (!record.agentNearAccountId) throw new Error("no agent");
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
    if (operation.state === "Unconfirmed") {
      await this.store.update(record, { state: "Unconfirmed", nextAttemptAt: null, lastError: null });
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
    if (operation.state === "Expired" || operation.state === "Failed" || operation.state === "Vetoed") {
      await this.store.releaseReference(record, operation.state);
      return;
    }
    if (operation.state === "Prepared") {
      if (blockTimestampNs > BigInt(operation.expires_at_ns)) {
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
    if (operation.state === "Queued") {
      if (blockTimestampNs > BigInt(operation.expires_at_ns)) {
        await this.near.expireOperation(record.vaultAccountId, id);
        await this.store.releaseReference(record, "Expired");
      } else if (
        operation.execute_after_ns !== null &&
        blockTimestampNs >= BigInt(operation.execute_after_ns)
      ) {
        const nearSigningTxHash = await this.near.executeQueuedOperation(record.vaultAccountId, id);
        await this.store.update(record, {
          state: "PossiblySigned",
          nearAuthorizationTxHash: nearSigningTxHash,
          nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
          lastError: null,
        });
      } else {
        await this.schedule(record, "Queued");
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
        // DAO transactions are started by the relayer, agent ones by the agent.
        operation.role === "__dao__" ? this.config.cancellationSenderAccountId : operation.member,
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
      await this.processCancellation(record, operation, blockTimestampNs);
      return;
    }
    if (operation.signed_transaction) {
      await this.processOriginal(record, operation, blockTimestampNs);
      return;
    }

    if (this.isStuck(operation, blockTimestampNs)) {
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
    blockTimestampNs: bigint,
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
        lastError: `waiting for confirmations ${depth}/${this.config.confirmations}`,
      });
      return;
    }
    if (receipt.status === "reverted") {
      // Reverted transactions are not provable by ForeignTx. Keep the budget spent.
      const config = await this.near.viewFunction<{ unconfirmed_after_ns: string }>(record.vaultAccountId, "get_settlement_config");
      const signedAt = BigInt(operation.possibly_signed_at_ns ?? operation.created_at_ns);
      if (blockTimestampNs >= signedAt + BigInt(config.unconfirmed_after_ns)) {
        if (!this.near.releaseUnconfirmed) throw new Error("release_unconfirmed gateway unavailable");
        await this.near.releaseUnconfirmed(record.vaultAccountId, opBytes(record.opId));
      }
      await this.schedule(record, "Broadcast");
      return;
    }
    if (receipt.blockNumber > await this.base.finalizedBlockNumber()) {
      await this.schedule(record, "Broadcast", "waiting for foreign-chain finality");
      return;
    }
    if (!receipt.blockHash || !this.near.settle) throw new Error("MPC settlement gateway requires a receipt block hash");
    await this.near.settle(record.vaultAccountId, opBytes(record.opId), receipt.blockHash);
    const settled = await this.near.getOperation(record.vaultAccountId, opBytes(record.opId));
    await this.store.update(record, {
      state: settled.state === "Confirmed" ? "Confirmed" : "Broadcast", txHash: hash,
      receiptBlock: receipt.blockNumber, lastAttemptAt: this.now(),
      nextAttemptAt: settled.state === "Confirmed" ? null : new Date(this.now().getTime() + this.config.pollIntervalMs), lastError: null,
    });
  }

  private async processCancellation(
    record: WorkerOperationRecord,
    operation: VaultOperation,
    blockTimestampNs: bigint,
  ): Promise<void> {
    const cancellation = operation.cancellation!;
    if (!cancellation.signed_transaction) {
      if (this.isStuck(operation, blockTimestampNs)) {
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
        lastError: `waiting for confirmations ${depth}/${this.config.confirmations}`,
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
    if (receipt.blockNumber > await this.base.finalizedBlockNumber()) {
      await this.schedule(record, "CancellationBroadcast", "waiting for foreign-chain finality");
      return;
    }
    if (!receipt.blockHash || !this.near.settle) throw new Error("MPC settlement gateway requires a receipt block hash");
    await this.near.settle(record.vaultAccountId, opBytes(record.opId), receipt.blockHash, true);
    await this.store.update(record, {
      state: "CancellationMined",
      cancellationTxHash: hash,
      receiptBlock: receipt.blockNumber,
      lastAttemptAt: this.now(),
      nextAttemptAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
      lastError: "cancellation mined; awaiting MPC verification",
    });
  }

  private async requestCancellation(
    record: WorkerOperationRecord,
    operation: VaultOperation,
    opId: number[],
  ): Promise<void> {
    const timing = await this.near.viewFunction<{ cancel_after_ns: string }>(record.vaultAccountId, "get_settlement_config");
    const now = await this.near.currentBlockTimestampNs();
    if (operation.cancellation || now < BigInt(operation.possibly_signed_at_ns ?? operation.created_at_ns) + BigInt(timing.cancel_after_ns)) {
      await this.schedule(record, record.txHash ? "Broadcast" : "PossiblySigned", "waiting for cancellation timeout or existing cancellation proof");
      return;
    }
    const nearTransactionHash = await this.near.cancelNonce(record.vaultAccountId, opId);
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

  private isStuck(operation: VaultOperation, blockTimestampNs: bigint): boolean {
    const since = operation.cancellation?.requested_at_ns ?? operation.possibly_signed_at_ns;
    if (since === null || since === undefined) return false;
    const thresholdNs = BigInt(this.config.stuckBlocks) * 1_000_000_000n;
    return blockTimestampNs - BigInt(since) >= thresholdNs;
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

