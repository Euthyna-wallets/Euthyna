import type { PrismaClient } from "@mandateos/db";
import { describe, expect, it } from "vitest";
import { bytesToHex, decodeFunctionData, getAddress, type Address } from "viem";
import { z } from "zod";

import { GovernanceService } from "./governance.js";
import type { NearClient } from "./near.js";
import type { GovernanceOperation } from "./types.js";

const operation: GovernanceOperation = {
  op_id: Array(32).fill(1) as number[],
  proposer: "dao.testnet",
  target: Array(20).fill(2) as number[],
  value: "0",
  data: [3, 4],
  operation: 1,
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
});


function fixture(
  proposalStatus = "Approved",
  activeOperation: number[] | null = operation.op_id,
  owners: Address[] = [
    getAddress("0x1111111111111111111111111111111111111111"),
    getAddress("0x2222222222222222222222222222222222222222"),
  ],
) {
  let stored: Record<string, unknown> | null = null;
  const prisma = {
    treasury: {
      findFirst: async () => ({
        id: "treasury-1",
        organizationId: "org-1",
        daoAccountId: "dao.testnet",
        relayAccountId: "relay.testnet",
        safeAddress: "0x3333333333333333333333333333333333333333",
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
        treasury: {
          daoAccountId: "dao.testnet",
        },
      }),
    },
  } as unknown as PrismaClient;
  const near = {
    viewFunction: async (_account: string, method: string) => {
      if (method === "get_proposal") {
        return { status: proposalStatus, description: "Batch Zodiac configuration [mandate:abc:zodiac]" };
      }
      if (method === "active_operation") return activeOperation;
      if (method === "get_operation") return operation;
      if (method === "client_id") return "acme";
      throw new Error(`unexpected view ${method}`);
    },
  } as unknown as NearClient;
  return {
    service: new GovernanceService(prisma, near, "https://sepolia.base.org", async () => owners),
    stored: () => stored,
  };
}

describe("GovernanceService", () => {
  it("records the public final-vote hash against the active relay operation", async () => {
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
      operation: 1,
    });
  });

  it("refuses to register a relay job before the DAO proposal executes", async () => {
    await expect(fixture("InProgress").service.recordRelayExecution("org-1", {
      proposalId: 7,
      nearTransactionHash: "near-final-vote-hash",
      signerAccountId: "alice.testnet",
    })).rejects.toMatchObject({ code: "proposal_not_executed" });
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
  });
});
