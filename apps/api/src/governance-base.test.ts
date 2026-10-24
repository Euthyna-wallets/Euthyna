import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, getAddress, type Hex } from "viem";

import { BaseGovernanceGateway } from "./governance-base.js";

const safe = getAddress("0x1111111111111111111111111111111111111111");
const delay = getAddress("0x2222222222222222222222222222222222222222");
const target = getAddress("0x3333333333333333333333333333333333333333");
const executionHash = `0x${"44".repeat(32)}` as Hex;
const vetoHash = `0x${"55".repeat(32)}` as Hex;
const privateKey = `0x${"01".repeat(32)}`;

const delayAbi = [{
  type: "function",
  name: "executeNextTx",
  stateMutability: "nonpayable",
  inputs: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
  ],
  outputs: [{ type: "bool" }],
}] as const;

function gateway(publicClient: Record<string, unknown>) {
  const result = new BaseGovernanceGateway("http://127.0.0.1:1", privateKey);
  Reflect.set(result, "publicClient", publicClient);
  return result;
}

describe("BaseGovernanceGateway execution evidence", () => {
  it("requires a Safe module-success event for Delay and exact executeNextTx calldata", async () => {
    const calldata = encodeFunctionData({
      abi: delayAbi,
      functionName: "executeNextTx",
      args: [target, 0n, "0x1234", 1],
    });
    const getLogs = vi.fn(async () => [{
      args: { module: delay },
      transactionHash: executionHash,
      blockNumber: 20n,
    }]);
    const getTransaction = vi.fn(async () => ({ to: delay, input: calldata }));
    const getTransactionReceipt = vi.fn(async () => ({ status: "success", blockNumber: 20n, logs: [] }));
    const base = gateway({ getBlockNumber: async () => 20n, getLogs, getTransaction, getTransactionReceipt });

    await expect(base.findExecution({
      safe,
      delay,
      to: target,
      value: 0n,
      data: "0x1234",
      operation: 1,
      fromBlock: 10n,
      toBlock: 20n,
    })).resolves.toMatchObject({
      evidence: { transactionHash: executionHash, blockNumber: 20n },
      scannedThroughBlock: 20n,
    });
    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({
      address: safe,
      args: { module: delay },
      fromBlock: 10n,
    }));

    await expect(base.findExecution({
      safe,
      delay,
      to: target,
      value: 0n,
      data: "0xabcd",
      operation: 1,
      fromBlock: 10n,
      toBlock: 20n,
    })).resolves.toEqual({ evidence: null, scannedThroughBlock: 20n });
  });

  it("accepts TxNonceSet as a veto only when the prior-block nonce had not passed the entry", async () => {
    const getLogs = vi.fn(async () => [{
      args: { nonce: 2n },
      transactionHash: vetoHash,
      blockNumber: 20n,
    }]);
    const readContract = vi.fn(async () => 0n);
    const base = gateway({ getBlockNumber: async () => 20n, getLogs, readContract });

    await expect(base.findVeto(delay, 0n, 10n, 20n)).resolves.toEqual({
      evidence: {
        transactionHash: vetoHash,
        blockNumber: 20n,
      },
      scannedThroughBlock: 20n,
    });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 19n }));

    readContract.mockResolvedValueOnce(1n);
    await expect(base.findVeto(delay, 0n, 10n, 20n)).resolves.toEqual({
      evidence: null,
      scannedThroughBlock: 20n,
    });
  });
});
