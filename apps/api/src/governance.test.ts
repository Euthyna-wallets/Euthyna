import type { PrismaClient } from "@mandateos/db";
import { describe, expect, it } from "vitest";
import { bytesToHex, decodeFunctionData, encodeFunctionData, getAddress, hexToBytes, type Address } from "viem";
import { z } from "zod";

import { GovernanceService } from "./governance.js";
import type { NearClient } from "./near.js";
import type { GovernanceOperation } from "./types.js";

const safeAddress = getAddress("0x3333333333333333333333333333333333333333");
const rolesAddress = getAddress("0x5555555555555555555555555555555555555555");
const recoveryAbi = [{
  type: "function",
  name: "swapOwner",
  stateMutability: "nonpayable",
  inputs: [
    { name: "prevOwner", type: "address" },
    { name: "oldOwner", type: "address" },
    { name: "newOwner", type: "address" },
  ],
  outputs: [],
}] as const;
const recoveryData = encodeFunctionData({
  abi: recoveryAbi,
  functionName: "swapOwner",
  args: [
    getAddress("0x1111111111111111111111111111111111111111"),
    getAddress("0x2222222222222222222222222222222222222222"),
    getAddress("0x4444444444444444444444444444444444444444"),
  ],
});

const operation: GovernanceOperation = {
  op_id: Array(32).fill(1) as number[],
  proposer: "dao.testnet",
  target: Array.from(hexToBytes(safeAddress)),
  value: "0",
  data: Array.from(hexToBytes(recoveryData)),
  operation: 0,
  evm_nonce: 0,
  transaction: {
    chain_id: 84532,
    nonce: 0,
    to: Array(20).fill(5) as number[],
    value: "0",
    input: [],
    gas_limit: "300000",
    max_fee_per_gas: "20000000000",
    max_priority_fee_per_gas: "1000000000",
  },
  tx_digest: Array(32).fill(6) as number[],
  possibly_signed_at_block: 1,
  state: "PossiblySigned",
  signature: null,
  signed_transaction: null,
  cancellation: null,
};

const proposalActionSchema = z.object({
  kind: z.object({
    FunctionCall: z.object({
      actions: z.array(z.object({ args: z.string() })).min(1),
    }),
  }),
});
const relayArgsSchema = z.object({
  target: z.string(),
  data: z.string(),
  operation: z.number(),
  gas_limit: z.string(),
  max_fee_per_gas: z.string(),
  max_priority_fee_per_gas: z.string(),
});

function daoProposal(
  relayOperation: GovernanceOperation,
  status: string,
  description = "Harmless description that must not be trusted",
) {
  return {
    status,
    description,
    kind: {
      FunctionCall: {
        receiver_id: "relay.testnet",
        actions: [{
          method_name: "propose",
          args: Buffer.from(JSON.stringify({
            target: Buffer.from(relayOperation.target).toString("base64"),
            value: relayOperation.value,
            data: Buffer.from(relayOperation.data).toString("base64"),
            operation: relayOperation.operation,
          })).toString("base64"),
        }],
      },
    },
  };
}


function daoCancellationProposal(opId: number[], status = "Approved") {
  return {
    status,
    description: "Completely unrelated text",
    kind: {
      FunctionCall: {
        receiver_id: "relay.testnet",
        actions: [{
          method_name: "cancel_nonce",
          args: Buffer.from(JSON.stringify({
            op_id: opId,
            gas_limit: "345678",
            max_fee_per_gas: "987654321",
            max_priority_fee_per_gas: "123456789",
          })).toString("base64"),
        }],
      },
    },
  };
}

function fixture(
  proposalStatus = "Approved",
  activeOperation: number[] | null = operation.op_id,
  owners: Address[] = [
    getAddress("0x1111111111111111111111111111111111111111"),
    getAddress("0x2222222222222222222222222222222222222222"),
  ],
  relayOperation: GovernanceOperation = operation,
  proposalValue: unknown = daoProposal(relayOperation, proposalStatus),
) {
  let stored: Record<string, unknown> | null = null;
  const prisma = {
    treasury: {
      findFirst: async () => ({
        id: "treasury-1",
        organizationId: "org-1",
        daoAccountId: "dao.testnet",
        relayAccountId: "relay.testnet",
        safeAddress,
        rolesAddress,
        baseChainId: 84532,
        delayAddress: "0x7777777777777777777777777777777777777777",
        govAddress: "0x8888888888888888888888888888888888888888",
      }),
    },
    member: { findFirst: async () => ({ id: "member-1" }) },
    governanceOperation: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        stored = create;
        return create;
      },
      findUnique: async () => ({
        organizationId: "org-1",
        opId: `0x${"01".repeat(32)}`,
        state: "Vetoed",
        relayAccountId: "relay.testnet",
        txHash: `0x${"07".repeat(32)}`,
        maxFeePerGas: "1",
        treasury: {
          daoAccountId: "dao.testnet",
          govAddress: "0x8888888888888888888888888888888888888888",
          delayAddress: "0x7777777777777777777777777777777777777777",
        },
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => ({
        opId: `0x${"01".repeat(32)}`,
        state: String(data.state ?? "CancellationRequested"),
        ...data,
      }),
    },
  } as unknown as PrismaClient;
  const near = {
    viewFunction: async (_account: string, method: string) => {
      if (method === "get_proposal") return proposalValue;
      if (method === "active_operation") return activeOperation;
      if (method === "get_operation") return relayOperation;
      if (method === "client_id") return "acme";
      throw new Error(`unexpected view ${method}`);
    },
  } as unknown as NearClient;
  return {
    service: new GovernanceService(prisma, near, {
      baseRpcUrl: "https://sepolia.base.org",
      gasEstimator: {
        quote: async () => ({
          gasLimit: 345_678n,
          maxFeePerGas: 98_765_432_100n,
          maxPriorityFeePerGas: 123_456_789n,
          baseFeePerGas: 30_000_000_000n,
          l1Fee: 10_000n,
          senderBalance: 10n ** 18n,
          requiredBalance: 98_765_432_100n * 345_678n + 10_000n,
          sufficientBalance: true,
        }),
        currentBaseFee: async () => 30_000_000_000n,
      },
      safeOwnersReader: async () => owners,
    }),
    stored: () => stored,
  };
}

describe("GovernanceService", () => {
  it("classifies the executed proposal from relay calldata rather than its description", async () => {
    const test = fixture();
    await expect(test.service.recordRelayExecution("org-1", {
      proposalId: 7,
      nearTransactionHash: "near-final-vote-hash",
      signerAccountId: "alice.testnet",
    })).resolves.toMatchObject({ state: "PossiblySigned" });
    expect(test.stored()).toMatchObject({
      organizationId: "org-1",
      proposalId: 7,
      nearExecutionTxHash: "near-final-vote-hash",
      nearExecutionSignerId: "alice.testnet",
      relayAccountId: "relay.testnet",
      operation: 0,
    });
  });


  it("rejects a DAO proposal whose relay calldata differs from the active operation", async () => {
    const mismatched = {
      ...operation,
      data: Array.from(hexToBytes(encodeFunctionData({
        abi: recoveryAbi,
        functionName: "swapOwner",
        args: [
          getAddress("0x1111111111111111111111111111111111111111"),
          getAddress("0x2222222222222222222222222222222222222222"),
          getAddress("0x6666666666666666666666666666666666666666"),
        ],
      }))),
    };
    await expect(fixture(
      "Approved",
      operation.op_id,
      undefined,
      operation,
      daoProposal(mismatched, "Approved", "Recover Safe owner"),
    ).service.recordRelayExecution("org-1", {
      proposalId: 7,
      nearTransactionHash: "near-final-vote-hash",
      signerAccountId: "alice.testnet",
    })).rejects.toMatchObject({ code: "proposal_operation_mismatch" });
  });

  it("rejects unsupported selectors and Safe owner calls sent to another target", async () => {
    const unsupported = { ...operation, data: Array.from(hexToBytes("0x12345678")) };
    await expect(fixture("Approved", operation.op_id, undefined, unsupported)
      .service.recordRelayExecution("org-1", {
        proposalId: 7,
        nearTransactionHash: "near-final-vote-hash",
        signerAccountId: "alice.testnet",
      })).rejects.toMatchObject({ code: "proposal_not_governance" });

    const wrongTarget = { ...operation, target: Array.from(hexToBytes(rolesAddress)) };
    await expect(fixture("Approved", operation.op_id, undefined, wrongTarget)
      .service.recordRelayExecution("org-1", {
        proposalId: 7,
        nearTransactionHash: "near-final-vote-hash",
        signerAccountId: "alice.testnet",
      })).rejects.toMatchObject({ code: "proposal_not_governance" });
  });
  it("records a cancellation vote by decoded op_id without trusting its description", async () => {
    const test = fixture(
      "Approved",
      operation.op_id,
      undefined,
      operation,
      daoCancellationProposal(operation.op_id),
    );
    await expect(test.service.recordRelayExecution("org-1", {
      proposalId: 9,
      nearTransactionHash: "near-cancellation-vote",
      signerAccountId: "alice.testnet",
    })).resolves.toEqual({
      opId: `0x${"01".repeat(32)}`,
      state: "CancellationRequested",
    });
  });

  it("refuses to register a relay job before the DAO proposal executes", async () => {
    await expect(fixture("InProgress").service.recordRelayExecution("org-1", {
      proposalId: 7,
      nearTransactionHash: "near-final-vote-hash",
      signerAccountId: "alice.testnet",
    })).rejects.toMatchObject({ code: "proposal_not_executed" });
  });
  it("builds a dynamically priced same-nonce cancellation for an underpriced relay operation", async () => {
    const opId = `0x${"01".repeat(32)}`;
    const proposal = await fixture().service.cancelUnderpricedProposal("org-1", opId);
    const proposalBody = proposalActionSchema.parse(proposal.args.proposal);
    const actionArgs = proposalBody.kind.FunctionCall.actions[0]!.args;
    expect(JSON.parse(Buffer.from(actionArgs, "base64").toString("utf8"))).toMatchObject({
      op_id: Array(32).fill(1),
      gas_limit: "345678",
      max_fee_per_gas: "98765432100",
      max_priority_fee_per_gas: "123456789",
    });
    expect(proposal.gasQuote).toMatchObject({ sufficientBalance: true });
  });


  it("builds a DAO confirm_original proposal only for the active terminal relay operation", async () => {
    const proposal = await fixture().service.unblockProposal("org-1", `0x${"01".repeat(32)}`);
    expect(proposal).toMatchObject({
      receiverId: "dao.testnet",
      methodName: "add_proposal",
      description: expect.stringContaining("Release terminal relay operation"),
      deposit: "100000000000000000000000",
    });
    const proposalBody = proposalActionSchema.parse(proposal.args.proposal);
    const actionArgs = proposalBody.kind.FunctionCall.actions[0]!.args;
    expect(JSON.parse(Buffer.from(actionArgs, "base64").toString("utf8"))).toMatchObject({
      op_id: Array(32).fill(1),
      tx_hash: Array(32).fill(7),
      mpc_signature: null,
    });
  });

  it("builds a relay proposal that swaps an existing Safe owner only while the relay is idle", async () => {
    const oldOwner = getAddress("0x2222222222222222222222222222222222222222");
    const newOwner = getAddress("0x4444444444444444444444444444444444444444");
    const proposal = await fixture("Approved", null).service.swapOwnerProposal("org-1", {
      oldOwner,
      newOwner,
    });
    const proposalBody = proposalActionSchema.parse(proposal.args.proposal);
    const actionArgs = proposalBody.kind.FunctionCall.actions[0]!.args;
    const relayArgs = relayArgsSchema.parse(
      JSON.parse(Buffer.from(actionArgs, "base64").toString("utf8")),
    );
    expect(bytesToHex(Buffer.from(relayArgs.target, "base64"))).toBe(
      "0x3333333333333333333333333333333333333333",
    );
    const decoded = decodeFunctionData({
      abi: [{
        type: "function",
        name: "swapOwner",
        stateMutability: "nonpayable",
        inputs: [
          { name: "prevOwner", type: "address" },
          { name: "oldOwner", type: "address" },
          { name: "newOwner", type: "address" },
        ],
        outputs: [],
      }] as const,
      data: bytesToHex(Buffer.from(relayArgs.data, "base64")),
    });
    expect(decoded.args).toEqual([
      getAddress("0x1111111111111111111111111111111111111111"),
      oldOwner,
      newOwner,
    ]);
    expect(relayArgs.operation).toBe(0);
    expect(relayArgs).toMatchObject({
      gas_limit: "345678",
      max_fee_per_gas: "98765432100",
      max_priority_fee_per_gas: "123456789",
    });
  });

  it("builds a relay proposal that adds a third Safe owner with threshold two", async () => {
    const newOwner = getAddress("0x4444444444444444444444444444444444444444");
    const proposal = await fixture("Approved", null).service.addOwnerProposal("org-1", { newOwner });
    const proposalBody = proposalActionSchema.parse(proposal.args.proposal);
    const actionArgs = proposalBody.kind.FunctionCall.actions[0]!.args;
    const relayArgs = relayArgsSchema.parse(
      JSON.parse(Buffer.from(actionArgs, "base64").toString("utf8")),
    );
    const decoded = decodeFunctionData({
      abi: [{
        type: "function",
        name: "addOwnerWithThreshold",
        stateMutability: "nonpayable",
        inputs: [
          { name: "owner", type: "address" },
          { name: "_threshold", type: "uint256" },
        ],
        outputs: [],
      }] as const,
      data: bytesToHex(Buffer.from(relayArgs.data, "base64")),
    });
    expect(decoded.args).toEqual([newOwner, 2n]);
    expect(relayArgs.operation).toBe(0);
    expect(relayArgs).toMatchObject({
      gas_limit: "345678",
      max_fee_per_gas: "98765432100",
      max_priority_fee_per_gas: "123456789",
    });
  });
});
