import {
  canonicalMultiSendAddress,
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

const roles = getAddress("0x1111111111111111111111111111111111111111");
const delay = getAddress("0x2222222222222222222222222222222222222222");
const member = getAddress("0x3333333333333333333333333333333333333333");
const token = getAddress("0x4444444444444444444444444444444444444444");
const roleKey = `0x${"55".repeat(32)}` as Hex;
const allowanceKey = `0x${"66".repeat(32)}` as Hex;
const queueHash = `0x${"77".repeat(32)}` as Hex;
const executeHash = `0x${"88".repeat(32)}` as Hex;
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
    target: Array.from(hexToBytes(canonicalMultiSendAddress(84532))),
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
    rolesAddress: roles,
    baseChainId: 84532,
    opId: `0x${"01".repeat(32)}`,
    clientId: "acme",
    state: "Queued",
    nearExecutionTxHash: "near-vote",
    nearExecutionSignerId: "alice.testnet",
    target: canonicalMultiSendAddress(84532),
    value: "0",
    data: `0x${Buffer.from(current.data).toString("hex")}`,
    operation: 1,
    txHash: queueHash,
    receiptBlock: 10n,
    queueNonce: 0n,
    queueCreatedAt: 100n,
    cooldownSeconds: 300n,
    nextAttemptAt: null,
    expirationSeconds: 604_800n,
    executeRawTransaction: null,
    executeTxHash: null,
    executeReceiptBlock: null,
    attempts: 0,
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
  currentBlock = 20n;
  delay: DelayState = {
    txNonce: 0n,
    queueNonce: 1n,
    cooldown: 300n,
    expiration: 604_800n,
    createdAt: 100n,
    currentTimestamp: 401n,
  };
  prepared = 0;
  broadcasts = 0;
  rawTransactionHash(): Hex { return queueHash; }
  broadcastRaw(): Promise<Hex> { this.broadcasts += 1; return Promise.resolve(queueHash); }
  receipt(hash: Hex): Promise<GovernanceReceipt | null> {
    return Promise.resolve(hash === queueHash ? this.queueReceipt : this.executeReceipt);
  }
  blockNumber(): Promise<bigint> { return Promise.resolve(this.currentBlock); }
  delayState(): Promise<DelayState> { return Promise.resolve(this.delay); }
  prepareExecuteNextTx(): Promise<PreparedDelayExecution> {
    this.prepared += 1;
    return Promise.resolve({ hash: executeHash, rawTransaction: "0x1234" });
  }
  verifyRoles(): Promise<RolesVerification> {
    return Promise.resolve({
      memberEnabled: true,
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
    relayStatusReport: vi.fn(async () => ({
      report: {
        client_id: "acme",
        op_id: Array(32).fill(1) as number[],
        kind: "Confirmed" as const,
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

  it("resumes after a crash following the on-chain relay report", async () => {
    const test = harness({
      state: "Reporting",
      executeRawTransaction: "0x1234",
      executeTxHash: executeHash,
    });
    test.near.current = { ...test.near.current, state: "Confirmed" };
    await test.worker().tick();
    expect(test.store.current.state).toBe("Executed");
    expect(test.near.reports).toBe(0);
  });

  it("does nothing before the on-chain cooldown elapses", async () => {
    const test = harness();
    test.base.delay.currentTimestamp = 399n;
    await test.worker().tick();
    expect(test.base.prepared).toBe(0);
    expect(test.store.current.state).toBe("Queued");
  });

  it("marks an entry vetoed when Delay txNonce passes its queue entry", async () => {
    const test = harness();
    test.base.delay.txNonce = 1n;
    await test.worker().tick();
    expect(test.store.current.state).toBe("Vetoed");
    expect(test.base.prepared).toBe(0);
  });

  it("waits for queue confirmations before reading or executing Delay", async () => {
    const test = harness();
    test.base.currentBlock = 12n;
    await test.worker().tick();
    expect(test.store.current.state).toBe("Broadcast");
    expect(test.base.prepared).toBe(0);
    expect(test.near.reports).toBe(0);
  });

  it("marks a reverted execute failed and never retries it", async () => {
    const test = harness({
      state: "Executing",
      executeRawTransaction: "0x1234",
      executeTxHash: executeHash,
    });
    test.base.executeReceipt = { status: "reverted", blockNumber: 15n, logs: [] };
    await test.worker().tick();
    expect(test.store.current.state).toBe("Failed");
    expect(test.store.current.nextAttemptAt).toBeNull();
    await expect(test.worker().tick()).resolves.toBe(0);
    expect(test.base.broadcasts).toBe(0);
  });
});
