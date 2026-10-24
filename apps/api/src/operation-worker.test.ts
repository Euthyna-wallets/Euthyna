import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

import {
  OperationWorker,
  type WorkerBaseGateway,
  type WorkerConfig,
  type WorkerNearGateway,
  type WorkerOperationRecord,
  type WorkerOperationUpdate,
  type WorkerStore,
} from "./operation-worker.js";
import type { MpcSignature, VaultOperation } from "./types.js";
import type { NearTransactionStatus } from "./near.js";

const opId = `0x${"01".repeat(32)}`;
const originalHash = `0x${"11".repeat(32)}` as Hex;
const cancellationHash = `0x${"22".repeat(32)}` as Hex;
const nowStart = new Date("2026-01-01T00:00:00.000Z");

function operation(overrides: Partial<VaultOperation> = {}): VaultOperation {
  return {
    op_id: Array(32).fill(1),
    client_id: "acme",
    member: "agent.testnet",
    role: "researcher",
    request: {
      chain_id: 84532,
      target: Array(20).fill(3),
      value: "0",
      calldata: [],
      allowance_amount: "100",
      reference: "INV-1",
      gas_limit: "200000",
      max_fee_per_gas: "20",
      max_priority_fee_per_gas: "10",
    },
    permission_index: 0,
    consumptions: [],
    measured_value: null,
    policy_version: 1,
    registry_version: 1,
    evm_nonce: 0,
    transaction: {
      chain_id: 84532,
      nonce: 0,
      to: Array(20).fill(3),
      value: "0",
      input: [],
      gas_limit: "200000",
      max_fee_per_gas: "20",
      max_priority_fee_per_gas: "10",
    },
    tx_digest: Array(32).fill(4),
    created_at_ns: "1000000000",
    expires_at_ns: "50000000000",
    execute_after_ns: null,
    visa_authorized: true,
    cosigned_by: null,
    possibly_signed_at_ns: "10000000000",
    state: "PossiblySigned",
    signature: { big_r: [2, ...Array(32).fill(1)], s: Array(32).fill(2), recovery_id: 0 },
    signed_transaction: [2, 1],
    cancellation: null,
    ...overrides,
  };
}

function record(overrides: Partial<WorkerOperationRecord> = {}): WorkerOperationRecord {
  return {
    organizationId: "org-1",
    opId,
    agentId: "agent-1",
    agentNearAccountId: "agent.testnet",
    agentEvmAddress: null,
    vaultAccountId: "vault.testnet",
    reference: "INV-1",
    state: "PossiblySigned",
    txHash: null,
    cancellationTxHash: null,
    nearAuthorizationTxHash: null,
    nearCancellationTxHash: null,
    receiptBlock: null,
    broadcastAt: null,
    cancellationRequestedAt: null,
    cancellationBroadcastAt: null,
    nextAttemptAt: null,
    lastError: null,
    attempts: 0,
    ...overrides,
  };
}

class FakeStore implements WorkerStore {
  leased = true;
  released: string[] = [];
  updates: WorkerOperationUpdate[] = [];
  syncedAgentAddresses: string[] = [];

  constructor(readonly operation: WorkerOperationRecord) {}

  acquireLease(): Promise<boolean> {
    return Promise.resolve(this.leased);
  }

  listReady(now: Date): Promise<WorkerOperationRecord[]> {
    const next = this.operation.nextAttemptAt;
    return Promise.resolve(!next || next <= now ? [this.operation] : []);
  }

  update(_operation: WorkerOperationRecord, data: WorkerOperationUpdate): Promise<void> {
    this.updates.push(data);
    Object.assign(this.operation, data);
    return Promise.resolve();
  }

  syncAgentEvmAddress(_operation: WorkerOperationRecord, evmAddress: string): Promise<void> {
    this.syncedAgentAddresses.push(evmAddress);
    return Promise.resolve();
  }

  releaseReference(_operation: WorkerOperationRecord, terminalState: "Cancelled" | "Expired" | "Failed" | "Vetoed"): Promise<void> {
    this.released.push(terminalState);
    this.operation.state = terminalState;
    return Promise.resolve();
  }
}

class FakeNear implements WorkerNearGateway {
  timestampNs = 20_000_000_000n;
  submitted: MpcSignature[] = [];
  reports = 0;
  cancellations = 0;
  queuedExecutions = 0;
  cancellationFees: Array<{ gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string }> = [];
  reportFailsAfterCommit = false;
  status: NearTransactionStatus = {};
  walletState: Record<string, unknown> = { address: Array(20).fill(0x11) };
  gasBalanceYocto = "100000000000000000000000";

  constructor(public operation: VaultOperation) {}
  getAccount(): Promise<{ amount: string }> {
    return Promise.resolve({ amount: this.gasBalanceYocto });
  }

  getOperation(): Promise<VaultOperation> {
    return Promise.resolve(this.operation);
  }


  currentBlockTimestampNs(): Promise<bigint> {
    return Promise.resolve(this.timestampNs);
  }

  executeQueuedOperation(): Promise<string> {
    this.queuedExecutions += 1;
    this.operation = { ...this.operation, state: "PossiblySigned" };
    return Promise.resolve("near-execute-queued");
  }

  transactionStatus(): Promise<NearTransactionStatus> {
    return Promise.resolve(this.status);
  }

  submitSignature(_vault: string, _opId: number[], signature: MpcSignature): Promise<string> {
    this.submitted.push(signature);
    this.operation = { ...this.operation, signature, signed_transaction: [2, 1] };
    return Promise.resolve("near-submit-signature");
  }

  reportStatus(_vault: string, signedReport: unknown): Promise<string> {
    this.reports += 1;
    const failed =
      signedReport !== null &&
      typeof signedReport === "object" &&
      "report" in signedReport &&
      signedReport.report !== null &&
      typeof signedReport.report === "object" &&
      "kind" in signedReport.report &&
      signedReport.report.kind === "Failed";
    this.operation = { ...this.operation, state: failed ? "Failed" : "Confirmed" };
    if (this.reportFailsAfterCommit) return Promise.reject(new Error("connection lost after commit"));
    return Promise.resolve("near-report");
  }

  expireOperation(): Promise<string> {
    this.operation = { ...this.operation, state: "Expired" };
    return Promise.resolve("near-expire");
  }

  cancelNonce(
    _vault: string,
    _opId: number[],
    gasLimit: string,
    maxFeePerGas: string,
    maxPriorityFeePerGas: string,
  ): Promise<string> {
    this.cancellations += 1;
    this.cancellationFees.push({ gasLimit, maxFeePerGas, maxPriorityFeePerGas });
    this.operation = {
      ...this.operation,
      cancellation: {
        transaction: {
          ...this.operation.transaction,
          to: Array(20).fill(9),
          input: [],
          gas_limit: gasLimit,
          max_fee_per_gas: maxFeePerGas,
          max_priority_fee_per_gas: maxPriorityFeePerGas,
        },
        tx_digest: Array(32).fill(8),
        signature: null,
        signed_transaction: null,
        requested_at_ns: this.timestampNs.toString(),
        request_count: this.cancellations,
      },
    };
    return Promise.resolve(`near-cancel-${this.cancellations}`);
  }

  viewFunction<T>(_accountId: string, methodName: string): Promise<T> {
    if (methodName === "is_paused") return Promise.resolve(true as T);
    if (methodName === "get_wallet") return Promise.resolve(this.walletState as T);
    if (methodName === "get_role") {
      return Promise.resolve({
        config: {
          gas_limit: "200000",
          max_fee_per_gas: "100",
          max_priority_fee_per_gas: "50",
          max_total_fee: "10000000",
        },
      } as T);
    }
    throw new Error(`unexpected view ${methodName}`);
  }
}

class FakeBase implements WorkerBaseGateway {
  broadcasts: Array<number[] | null> = [];
  receipts = new Map<Hex, { status: "success" | "reverted"; blockNumber: bigint } | null>();
  head = 104n;

  rawTransactionHash(raw: number[] | null): Hex {
    return raw?.[0] === 9 ? cancellationHash : originalHash;
  }

  broadcastRaw(raw: number[] | null): Promise<Hex> {
    this.broadcasts.push(raw);
    return Promise.resolve(this.rawTransactionHash(raw));
  }

  receipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint } | null> {
    return Promise.resolve(this.receipts.get(hash) ?? null);
  }

  blockNumber(): Promise<bigint> {
    return Promise.resolve(this.head);
  }
}

const config: WorkerConfig = {
  pollIntervalMs: 1_000,
  confirmations: 5,
  leaseMs: 10_000,
  stuckBlocks: 5,
  broadcastTimeoutMs: 5_000,
  retryBaseMs: 100,
  retryMaxMs: 10_000,
  cancellationSenderAccountId: "mandateos.testnet",
  agentGasLowYocto: "50000000000000000000000",
};

function harness(overrides: Partial<VaultOperation> = {}) {
  let now = new Date(nowStart);
  const store = new FakeStore(record());
  const near = new FakeNear(operation(overrides));
  const base = new FakeBase();
  const report = async (
    current: VaultOperation,
    hash: Hex,
    blockNumber: bigint,
    kind: "Confirmed" | "Failed",
  ) => ({
    report: {
      client_id: current.client_id,
      op_id: current.op_id,
      kind,
      tx_hash: Array.from(Buffer.from(hash.slice(2), "hex")),
      report_nonce: 7,
      block_number: Number(blockNumber),
    },
    signature: "signed-report",
  });
  const guard = {
    confirmationReport: (current: VaultOperation, hash: Hex, blockNumber: bigint) =>
      report(current, hash, blockNumber, "Confirmed"),
    failureReport: (current: VaultOperation, hash: Hex, blockNumber: bigint) =>
      report(current, hash, blockNumber, "Failed"),
  };
  const createWorker = () => new OperationWorker(store, near, base, guard, config, () => now);
  return {
    store,
    near,
    base,
    createWorker,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

function mpcStatus(): NearTransactionStatus {
  const response = {
    scheme: "Secp256k1",
    big_r: { affine_point: `02${"11".repeat(32)}` },
    s: { scalar: "22".repeat(32) },
    recovery_id: 1,
  };
  return {
    receipts_outcome: [{
      outcome: { status: { SuccessValue: Buffer.from(JSON.stringify(response)).toString("base64") } },
    }],
  };
}

describe("OperationWorker", () => {
  it("broadcasts once, then a restarted worker confirms the successful receipt", async () => {
    const test = harness();
    await test.createWorker().tick();
    expect(test.base.broadcasts).toEqual([[2, 1]]);
    expect(test.store.operation).toMatchObject({ state: "Broadcast", txHash: originalHash });

    test.base.receipts.set(originalHash, { status: "success", blockNumber: 99n });
    test.advance(1_000);
    await test.createWorker().tick();
    expect(test.base.broadcasts).toHaveLength(1);
    expect(test.near.reports).toBe(1);
    expect(test.store.operation).toMatchObject({ state: "Confirmed", receiptBlock: 99n });
  });

  it("does not report a receipt before WORKER_CONFIRMATIONS depth", async () => {
    const test = harness();
    test.store.operation.txHash = originalHash;
    test.store.operation.broadcastAt = new Date(nowStart);
    test.base.receipts.set(originalHash, { status: "success", blockNumber: 99n });
    test.base.head = 102n;
    await test.createWorker().tick();
    expect(test.near.reports).toBe(0);
    expect(test.store.operation).toMatchObject({
      state: "Broadcast",
      txHash: originalHash,
      receiptBlock: 99n,
      lastError: "waiting for Base confirmations 4/5",
    });
  });

  it("recovers after report_status committed but its RPC response was lost", async () => {
    const test = harness();
    test.store.operation.txHash = originalHash;
    test.store.operation.broadcastAt = new Date(nowStart);
    test.base.receipts.set(originalHash, { status: "success", blockNumber: 99n });
    test.near.reportFailsAfterCommit = true;
    await test.createWorker().tick();
    expect(test.near.operation.state).toBe("Confirmed");
    expect(test.store.operation.state).not.toBe("Confirmed");

    test.advance(1_000);
    await test.createWorker().tick();
    expect(test.store.operation.state).toBe("Confirmed");
    expect(test.store.operation.txHash).toBe(originalHash);
    expect(test.near.reports).toBe(1);
  });

  it("extracts a published MPC response and calls submit_signature before broadcast", async () => {
    const test = harness({ signature: null, signed_transaction: null });
    test.store.operation.nearAuthorizationTxHash = "near-authorize";
    test.near.status = mpcStatus();
    await test.createWorker().tick();
    expect(test.near.submitted).toHaveLength(1);
    expect(test.near.submitted[0]).toMatchObject({ recovery_id: 1 });
    expect(test.base.broadcasts).toEqual([[2, 1]]);
  });


  it("synchronizes the shared ACME wallet while processing an operation", async () => {
    const test = harness();
    test.near.walletState = { address: Array(20).fill(0x11) };
    await test.createWorker().tick();
    expect(test.store.syncedAgentAddresses).toEqual(["0x1111111111111111111111111111111111111111"]);
  });
  it("requests and broadcasts a same-nonce cancellation, then releases only after on-chain confirmation", async () => {
    const test = harness({ signature: null, signed_transaction: null });
    test.near.timestampNs = 20_000_000_000n;
    await test.createWorker().tick();
    expect(test.near.cancellations).toBe(1);
    expect(test.store.operation).toMatchObject({
      state: "CancellationRequested",
      nearCancellationTxHash: "near-cancel-1",
    });
    expect(test.near.cancellationFees).toEqual([{
      gasLimit: "21000",
      maxFeePerGas: "22",
      maxPriorityFeePerGas: "11",
    }]);

    test.near.operation.cancellation!.signature = {
      big_r: [2, ...Array(32).fill(3)],
      s: Array(32).fill(4),
      recovery_id: 0,
    };
    test.near.operation.cancellation!.signed_transaction = [9, 1];
    test.advance(1_000);
    await test.createWorker().tick();
    expect(test.base.broadcasts).toEqual([[9, 1]]);
    expect(test.store.operation.state).toBe("CancellationBroadcast");

    test.base.receipts.set(cancellationHash, { status: "success", blockNumber: 100n });
    test.advance(1_000);
    await test.createWorker().tick();
    expect(test.store.operation.state).toBe("CancellationMined");
    expect(test.store.released).toEqual([]);

    test.near.operation = { ...test.near.operation, state: "Cancelled" };
    test.advance(1_000);
    await test.createWorker().tick();
    expect(test.store.released).toEqual(["Cancelled"]);
  });

  it("warns without blocking when the agent NEAR gas balance is low", async () => {
    const test = harness();
    test.near.gasBalanceYocto = "10000000000000000000000";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await test.createWorker().tick();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("\"event\":\"agent.gas_balance_low\""));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("send a simple NEAR transfer to agent.testnet"));
    warning.mockRestore();
  });

  it("expires Prepared operations and releases their references", async () => {
    const test = harness({
      state: "Prepared",
      possibly_signed_at_ns: null,
      signature: null,
      signed_transaction: null,
      expires_at_ns: "10000000000",
    });
    test.near.timestampNs = 11_000_000_000n;
    await test.createWorker().tick();
    expect(test.store.released).toEqual(["Expired"]);
  });

  it("executes a delayed operation only after its on-chain waiting period", async () => {
    const before = harness({
      state: "Queued",
      signed_transaction: null,
      signature: null,
      execute_after_ns: "25000000000",
    });
    await before.createWorker().tick();
    expect(before.near.queuedExecutions).toBe(0);
    expect(before.store.operation.state).toBe("Queued");

    const ready = harness({
      state: "Queued",
      signed_transaction: null,
      signature: null,
      execute_after_ns: "15000000000",
    });
    await ready.createWorker().tick();
    expect(ready.near.queuedExecutions).toBe(1);
    expect(ready.store.operation.state).toBe("PossiblySigned");
    expect(ready.store.operation.nearAuthorizationTxHash).toBe("near-execute-queued");
  });

  it("reports a reverted original and releases its policy reservations", async () => {
    const test = harness();
    test.store.operation.txHash = originalHash;
    test.store.operation.broadcastAt = new Date(nowStart);
    test.base.receipts.set(originalHash, { status: "reverted", blockNumber: 42n });
    await test.createWorker().tick();
    expect(test.store.operation.state).toBe("Failed");
    expect(test.store.released).toEqual(["Failed"]);
    expect(test.near.reports).toBe(1);
  });

  it("does no work while another process holds the lease", async () => {
    const test = harness();
    test.store.leased = false;
    await expect(test.createWorker().tick()).resolves.toEqual({ leased: false, processed: 0 });
    expect(test.base.broadcasts).toEqual([]);
  });
  it("runs governance jobs under the same worker lease", async () => {
    const test = harness();
    test.store.operation.nextAttemptAt = new Date("2030-01-01T00:00:00.000Z");
    const governance = { tick: vi.fn(async () => 1) };
    const worker = new OperationWorker(
      test.store,
      test.near,
      test.base,
      {
        confirmationReport: async (current: VaultOperation, hash: Hex, blockNumber: bigint) => ({
          report: {
            client_id: current.client_id,
            op_id: current.op_id,
            kind: "Confirmed" as const,
            tx_hash: Array.from(Buffer.from(hash.slice(2), "hex")),
            report_nonce: 1,
            block_number: Number(blockNumber),
          },
          signature: "signed",
        }),
        failureReport: async (current: VaultOperation, hash: Hex, blockNumber: bigint) => ({
          report: {
            client_id: current.client_id,
            op_id: current.op_id,
            kind: "Failed" as const,
            tx_hash: Array.from(Buffer.from(hash.slice(2), "hex")),
            report_nonce: 2,
            block_number: Number(blockNumber),
          },
          signature: "signed",
        }),
      },
      config,
      () => new Date(nowStart),
      governance,
    );
    await expect(worker.tick()).resolves.toEqual({ leased: true, processed: 1 });
    expect(governance.tick).toHaveBeenCalledOnce();
  });

});
