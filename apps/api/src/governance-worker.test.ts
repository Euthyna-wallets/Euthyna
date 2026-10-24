import {
  canonicalMultiSendCallOnlyAddress,
  encodeMultiSendTransactions,
  rolesAbi,
} from "@mandateos/deployer";
import { describe, expect, it, vi } from "vitest";
import {
  encodeFunctionData,
  getAddress,
  hexToBytes,
  type Address,
  type Hex,
} from "viem";

import type {
  DelayState,
  DelayExecutionEvidence,
  DelayVetoEvidence,
  EvidenceScanResult,
  GovernanceBaseGateway,
  GovernanceReceipt,
  PreparedDelayExecution,
  RolesVerification,
} from "./governance-base.js";
import {
  GovernanceWorker,
  type GovernanceJobRecord,
  type GovernanceJobUpdate,
  type GovernanceNearGateway,
  type GovernanceStore,
  type GovernanceTreasuryRecord,
} from "./governance-worker.js";
import type { GovernanceOperation, MpcSignature } from "./types.js";
const entryHash = `0x${"99".repeat(32)}` as Hex;

const roles = getAddress("0x1111111111111111111111111111111111111111");
const delay = getAddress("0x2222222222222222222222222222222222222222");
const safe = getAddress("0x1212121212121212121212121212121212121212");
const member = getAddress("0x3333333333333333333333333333333333333333");
const token = getAddress("0x4444444444444444444444444444444444444444");
const roleKey = `0x${"55".repeat(32)}` as Hex;
const allowanceKey = `0x${"66".repeat(32)}` as Hex;
const queueHash = `0x${"77".repeat(32)}` as Hex;
const executeHash = `0x${"88".repeat(32)}` as Hex;
const cancellationHash = `0x${"89".repeat(32)}` as Hex;
const now = new Date("2026-01-01T00:00:00.000Z");

const multiSendAbi = [{
  type: "function",
  name: "multiSend",
  stateMutability: "payable",
  inputs: [{ name: "transactions", type: "bytes" }],
  outputs: [],
}] as const;

function operation(): GovernanceOperation {
  const calls = [
    encodeFunctionData({ abi: rolesAbi, functionName: "assignRoles", args: [member, [roleKey], [true]] }),
    encodeFunctionData({ abi: rolesAbi, functionName: "scopeTarget", args: [roleKey, token] }),
    encodeFunctionData({ abi: rolesAbi, functionName: "scopeFunction", args: [roleKey, token, "0xa9059cbb", [], 0] }),
    encodeFunctionData({
      abi: rolesAbi,
      functionName: "setAllowance",
      args: [allowanceKey, 6_000_000n, 6_000_000n, 6_000_000n, 2_592_000n, 1_700_000_000n],
    }),
  ];
  const packed = encodeMultiSendTransactions(calls.map((data) => ({ operation: 0, to: roles, value: 0n, data })));
  const data = encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed] });
  return {
    op_id: Array(32).fill(1) as number[],
    proposer: "dao.testnet",
    target: Array.from(hexToBytes(canonicalMultiSendCallOnlyAddress(84532))),
    value: "0",
    data: Array.from(hexToBytes(data)),
    operation: 1,
    evm_nonce: 0,
    transaction: {
      chain_id: 84532,
      nonce: 0,
      to: Array.from(hexToBytes(delay)),
      value: "0",
      input: [],
      gas_limit: "300000",
      max_fee_per_gas: "20000000000",
      max_priority_fee_per_gas: "1000000000",
    },
    tx_digest: Array(32).fill(2) as number[],
    possibly_signed_at_block: 1,
    state: "PossiblySigned",
    signature: { big_r: Array(33).fill(2), s: Array(32).fill(3) as number[], recovery_id: 0 },
    signed_transaction: [1, 2, 3],
    cancellation: null,
  };
}

function job(overrides: Partial<GovernanceJobRecord> = {}): GovernanceJobRecord {
  const current = operation();
  return {
    id: "treasury-1",
    organizationId: "org-1",
    relayAccountId: "relay.testnet",
    delayAddress: delay,
    safeAddress: safe,
    rolesAddress: roles,
    baseChainId: 84532,
    opId: `0x${"01".repeat(32)}`,
    clientId: "acme",
    state: "Queued",
    finalStatus: null,
    nearExecutionTxHash: "near-vote",
    nearCancellationTxHash: null,
    nearCancellationSignerId: null,
    nearExecutionSignerId: "alice.testnet",
    target: canonicalMultiSendCallOnlyAddress(84532),
    value: "0",
    data: `0x${Buffer.from(current.data).toString("hex")}`,
    gasLimit: "300000",
    maxFeePerGas: "20000000000",
    maxPriorityFeePerGas: "1000000000",
    operation: 1,
    txHash: queueHash,
    receiptBlock: 10n,
    queueNonce: 0n,
    queueCreatedAt: 100n,
    executionScannedThroughBlock: null,
    vetoScannedThroughBlock: null,
    cooldownSeconds: 300n,
    nextAttemptAt: null,
    expirationSeconds: 604_800n,
    executeRawTransaction: null,
    executeTxHash: null,
    cancellationTxHash: null,
    cancellationReceiptBlock: null,
    executeReceiptBlock: null,
    attempts: 0,
    lastError: null,
    ...overrides,
  };
}

class FakeStore implements GovernanceStore {
  updates: GovernanceJobUpdate[] = [];
  constructor(readonly current: GovernanceJobRecord) {}
  listTreasuries(): Promise<GovernanceTreasuryRecord[]> { return Promise.resolve([]); }
  upsertDiscovered(): Promise<void> { return Promise.resolve(); }
  listReady(): Promise<GovernanceJobRecord[]> {
    return Promise.resolve(["Executed", "Vetoed", "Expired", "Failed"].includes(this.current.state) ? [] : [this.current]);
  }
  update(_job: GovernanceJobRecord, update: GovernanceJobUpdate): Promise<void> {
    this.updates.push(update);
    Object.assign(this.current, update);
    return Promise.resolve();
  }
}

class FakeNear implements GovernanceNearGateway {
  reports = 0;
  current = operation();
  viewFunction<T>(_account: string, method: string): Promise<T> {
    if (method === "get_operation") return Promise.resolve(this.current as T);
    throw new Error(`unexpected view ${method}`);
  }
  transactionStatus(): Promise<never> { throw new Error("not needed"); }
  submitSignature(_relay: string, _id: number[], _signature: MpcSignature): Promise<string> {
    return Promise.resolve("near-signature");
  }
  reportStatus(): Promise<string> {
    this.reports += 1;
    this.current = { ...this.current, state: "Confirmed" };
    return Promise.resolve("near-report");
  }
}

class FakeBase implements GovernanceBaseGateway {
  queueReceipt: GovernanceReceipt | null = { status: "success", blockNumber: 10n, logs: [] };
  executeReceipt: GovernanceReceipt | null = null;
  cancellationReceipt: GovernanceReceipt | null = null;
  currentBlock = 20n;
  delay: DelayState = {
    txNonce: 0n,
    queueNonce: 1n,
    cooldown: 300n,
    expiration: 604_800n,
    entryHash,
    createdAt: 100n,
    currentTimestamp: 401n,
  };
  prepared = 0;
  broadcasts = 0;
  rolesEnabled = true;
  execution: DelayExecutionEvidence | null = null;
  veto: DelayVetoEvidence | null = null;
  executionFromBlocks: bigint[] = [];
  executionToBlocks: bigint[] = [];
  vetoFromBlocks: bigint[] = [];
  rawTransactionHash(raw: number[] | null): Hex {
    return raw?.[0] === 9 ? cancellationHash : queueHash;
  }
  broadcastRaw(): Promise<Hex> { this.broadcasts += 1; return Promise.resolve(queueHash); }
  receipt(hash: Hex): Promise<GovernanceReceipt | null> {
    if (hash === queueHash) return Promise.resolve(this.queueReceipt);
    if (hash === cancellationHash) return Promise.resolve(this.cancellationReceipt);
    return Promise.resolve(this.executeReceipt);
  }
  blockNumber(): Promise<bigint> { return Promise.resolve(this.currentBlock); }
  delayState(): Promise<DelayState> { return Promise.resolve(this.delay); }
  expectedHash = entryHash;
  expectedDelayHash(): Hex { return this.expectedHash; }
  findExecution(input: { fromBlock: bigint; toBlock: bigint }): Promise<EvidenceScanResult<DelayExecutionEvidence>> {
    this.executionFromBlocks.push(input.fromBlock);
    this.executionToBlocks.push(input.toBlock);
    const evidence = this.execution?.blockNumber !== undefined && this.execution.blockNumber <= input.toBlock
      ? this.execution
      : null;
    return Promise.resolve({ evidence, scannedThroughBlock: input.toBlock });
  }
  findVeto(
    _delay: Address,
    _entryNonce: bigint,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<EvidenceScanResult<DelayVetoEvidence>> {
    this.vetoFromBlocks.push(fromBlock);
    const evidence = this.veto?.blockNumber !== undefined && this.veto.blockNumber <= toBlock
      ? this.veto
      : null;
    return Promise.resolve({ evidence, scannedThroughBlock: toBlock });
  }
  prepareExecuteNextTx(): Promise<PreparedDelayExecution> {
    this.prepared += 1;
    return Promise.resolve({ hash: executeHash, rawTransaction: "0x1234" });
  }
  verifyRoles(): Promise<RolesVerification> {
    return Promise.resolve({
      memberEnabled: this.rolesEnabled,
      allowance: {
        refill: 6_000_000n,
        maxRefill: 6_000_000n,
        period: 2_592_000n,
        balance: 6_000_000n,
        timestamp: 1_700_000_000n,
      },
      events: ["AssignRoles", "ScopeTarget", "ScopeFunction", "SetAllowance"],
    });
  }
  gasWalletAddress(): Address { return getAddress("0x9999999999999999999999999999999999999999"); }
  gasWalletBalance(): Promise<bigint> { return Promise.resolve(10n ** 18n); }
}

function harness(overrides: Partial<GovernanceJobRecord> = {}) {
  const store = new FakeStore(job(overrides));
  const near = new FakeNear();
  const base = new FakeBase();
  const guard = {
    relayStatusReport: vi.fn(async (
      _clientId: string,
      _operation: GovernanceOperation,
      _hash: Hex,
      _blockNumber: bigint,
      finalStatus: "Executed" | "Vetoed" | "Expired" | "Failed",
    ) => ({
      report: {
        client_id: "acme",
        op_id: Array(32).fill(1) as number[],
        final_status: finalStatus,
        tx_hash: Array(32).fill(7) as number[],
        report_nonce: 9,
        block_number: 10,
      },
      signature: "signed",
    })),
  };
  const worker = () => new GovernanceWorker(store, near, base, guard, {
    confirmations: 5,
    pollIntervalMs: 1_000,
    retryBaseMs: 100,
    retryMaxMs: 10_000,
    gasWalletMinimumWei: 1n,
  }, () => now);
  return { store, near, base, guard, worker };
}

describe("GovernanceWorker", () => {
  it("checkpoints a signed execute transaction before broadcast and resumes after a crash", async () => {
    const test = harness();
    await test.worker().tick();
    expect(test.base.prepared).toBe(1);
    expect(test.base.broadcasts).toBe(0);
    expect(test.store.current.state).toBe("Executing");
    expect(test.store.current.executeTxHash).toBe(executeHash);

    await test.worker().tick();
    expect(test.base.prepared).toBe(1);
    expect(test.base.broadcasts).toBe(1);

    test.base.executeReceipt = { status: "success", blockNumber: 15n, logs: [] };
    test.base.delay.txNonce = 1n;
    test.base.execution = {
      transactionHash: executeHash,
      blockNumber: 15n,
      receipt: test.base.executeReceipt,
    };
    await test.worker().tick();
    expect(test.store.current.state).toBe("Reporting");
    expect(test.near.reports).toBe(0);
    await test.worker().tick();
    expect(test.store.current.state).toBe("Executed");
    expect(test.near.reports).toBe(1);
    await test.worker().tick();
    expect(test.base.prepared).toBe(1);
    expect(test.base.broadcasts).toBe(1);
  });

  it("broadcasts a signed same-nonce cancellation and releases the relay as Failed", async () => {
    const test = harness({
      state: "CancellationRequested",
      nearCancellationTxHash: "near-cancellation-vote",
      nearCancellationSignerId: "alice.testnet",
    });
    const current = operation();
    current.cancellation = {
      transaction: {
        ...current.transaction,
        to: Array(20).fill(9) as number[],
        input: [],
      },
      tx_digest: Array(32).fill(9) as number[],
      signature: { big_r: Array(33).fill(9), s: Array(32).fill(9) as number[], recovery_id: 0 },
      signed_transaction: [9, 1, 2],
      requested_at_ns: "10000000000",
      request_count: 1,
    };
    test.near.current = current;
    test.base.cancellationReceipt = { status: "success", blockNumber: 15n, logs: [] };
    await test.worker().tick();
    expect(test.store.current.state).toBe("Reporting");
    expect(test.store.current.finalStatus).toBe("Failed");
    expect(test.store.current.cancellationTxHash).toBe(cancellationHash);
    await test.worker().tick();
    expect(test.store.current.state).toBe("Failed");
    expect(test.near.reports).toBe(1);
  });

  it("resumes after a crash following the on-chain relay report", async () => {
    const test = harness({
      state: "Reporting",
      finalStatus: "Executed",
      executeRawTransaction: "0x1234",
      executeTxHash: executeHash,
    });
    test.near.current = { ...test.near.current, state: "Confirmed" };
    await test.worker().tick();
    expect(test.store.current.state).toBe("Executed");
    expect(test.near.reports).toBe(0);
  });

  it("polls during cooldown without rescanning already checked Base blocks", async () => {
    const test = harness();
    test.base.delay.currentTimestamp = 399n;
    await test.worker().tick();
    expect(test.base.prepared).toBe(0);
    expect(test.store.current.state).toBe("Queued");
    expect(test.store.current.executionScannedThroughBlock).toBe(15n);
    expect(test.store.current.nextAttemptAt).toEqual(new Date(now.getTime() + 1_000));
    test.base.currentBlock = 21n;
    await test.worker().tick();
    expect(test.base.executionFromBlocks).toEqual([10n, 16n]);
    expect(test.base.executionToBlocks).toEqual([15n, 16n]);
    expect(test.store.current.executionScannedThroughBlock).toBe(16n);
  });


  it("finds an execution that was inside the confirmation window on the next poll", async () => {
    const test = harness();
    test.base.delay.txNonce = 1n;
    test.base.delay.currentTimestamp = 605_201n;
    test.base.execution = {
      transactionHash: `0x${"ac".repeat(32)}`,
      blockNumber: 18n,
      receipt: { status: "success", blockNumber: 18n, logs: [] },
    };
    await test.worker().tick();
    expect(test.store.current.state).toBe("Queued");
    expect(test.store.current.executionScannedThroughBlock).toBe(15n);
    expect(test.store.current.finalStatus).toBeNull();

    test.base.currentBlock = 23n;
    await test.worker().tick();
    expect(test.base.executionFromBlocks).toEqual([10n, 16n]);
    expect(test.base.executionToBlocks).toEqual([15n, 18n]);
    expect(test.store.current.state).toBe("Reporting");
    expect(test.store.current.finalStatus).toBe("Executed");
  });
  it("finds a veto that was inside the confirmation window on the next poll", async () => {
    const test = harness();
    test.base.delay.txNonce = 1n;
    test.base.delay.currentTimestamp = 605_201n;
    test.base.veto = {
      transactionHash: `0x${"ad".repeat(32)}`,
      blockNumber: 18n,
    };
    await test.worker().tick();
    expect(test.store.current.state).toBe("Queued");
    expect(test.store.current.finalStatus).toBeNull();
    expect(test.store.current.vetoScannedThroughBlock).toBe(15n);

    test.base.currentBlock = 23n;
    await test.worker().tick();
    expect(test.base.vetoFromBlocks).toEqual([10n, 16n]);
    expect(test.store.current.state).toBe("Reporting");
    expect(test.store.current.finalStatus).toBe("Vetoed");
  });

  it("reports a veto even when Roles already matches the proposed state", async () => {
    const test = harness();
    test.base.delay.txNonce = 1n;
    test.base.veto = { transactionHash: `0x${"ab".repeat(32)}`, blockNumber: 15n };
    await test.worker().tick();
    expect(test.store.current.state).toBe("Reporting");
    expect(test.store.current.finalStatus).toBe("Vetoed");
    await test.worker().tick();
    expect(test.store.current.state).toBe("Vetoed");
    expect(test.near.reports).toBe(1);
    expect(test.base.prepared).toBe(0);
  });

  it("classifies third-party execution before expiry even when observed after expiration", async () => {
    const test = harness();
    test.base.delay.txNonce = 1n;
    test.base.delay.currentTimestamp = 605_201n;
    test.base.execution = {
      transactionHash: `0x${"ac".repeat(32)}`,
      blockNumber: 15n,
      receipt: { status: "success", blockNumber: 15n, logs: [] },
    };
    await test.worker().tick();
    expect(test.store.current.state).toBe("Reporting");
    expect(test.store.current.finalStatus).toBe("Executed");
    expect(test.store.updates.at(-1)?.rolesVerification).toMatchObject({ mode: "zodiac" });
  });

  it("reports an expired Delay entry and releases the relay", async () => {
    const test = harness();
    test.base.delay.currentTimestamp = 605_201n;
    await test.worker().tick();
    expect(test.store.current.state).toBe("Reporting");
    expect(test.store.current.finalStatus).toBe("Expired");
    await test.worker().tick();
    expect(test.store.current.state).toBe("Expired");
    expect(test.near.reports).toBe(1);
  });

  it("waits for queue confirmations before reading or executing Delay", async () => {
    const test = harness();
    test.base.currentBlock = 12n;
    await test.worker().tick();
    expect(test.store.current.state).toBe("Broadcast");
    expect(test.base.prepared).toBe(0);
    expect(test.near.reports).toBe(0);
  });

  it("refuses a Delay queue entry whose stored txHash differs from the governed call", async () => {
    const test = harness();
    test.base.delay.entryHash = `0x${"10".repeat(32)}`;
    await test.worker().tick();
    expect(test.store.current.lastError).toContain("Delay entry hash");
    expect(test.base.prepared).toBe(0);
  });

  it("reports a reverted execute as Failed and never retries it", async () => {
    const test = harness({
      state: "Executing",
      executeRawTransaction: "0x1234",
      executeTxHash: executeHash,
    });
    test.base.executeReceipt = { status: "reverted", blockNumber: 15n, logs: [] };
    await test.worker().tick();
    expect(test.store.current.state).toBe("Reporting");
    expect(test.store.current.finalStatus).toBe("Failed");
    await test.worker().tick();
    expect(test.store.current.state).toBe("Failed");
    expect(test.store.current.nextAttemptAt).toBeNull();
    await expect(test.worker().tick()).resolves.toBe(0);
    expect(test.base.broadcasts).toBe(0);
  });

  it("classifies a generic execution before a later veto of the following entry", async () => {
    const test = harness({
      target: "0x5555555555555555555555555555555555555555",
      data: "0x1234",
      operation: 0,
    });
    test.base.delay.txNonce = 2n;
    test.base.execution = {
      transactionHash: `0x${"ad".repeat(32)}`,
      blockNumber: 14n,
      receipt: { status: "success", blockNumber: 14n, logs: [] },
    };
    test.base.veto = { transactionHash: `0x${"ae".repeat(32)}`, blockNumber: 15n };
    await test.worker().tick();
    expect(test.store.current.state).toBe("Reporting");
    expect(test.store.current.finalStatus).toBe("Executed");
    expect(test.store.updates.at(-1)?.rolesVerification).toEqual({
      mode: "receipt-only",
      delayEntryHashVerified: true,
    });
    await test.worker().tick();
    expect(test.store.current.state).toBe("Executed");
  });
});
