import type { PrismaClient } from "@mandateos/db";
import { describe, expect, it } from "vitest";

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

function fixture(proposalStatus = "Approved") {
  let stored: Record<string, unknown> | null = null;
  const prisma = {
    treasury: {
      findFirst: async () => ({
        id: "treasury-1",
        organizationId: "org-1",
        daoAccountId: "dao.testnet",
        relayAccountId: "relay.testnet",
      }),
    },
    member: { findFirst: async () => ({ id: "member-1" }) },
    governanceOperation: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        stored = create;
        return create;
      },
    },
  } as unknown as PrismaClient;
  const near = {
    viewFunction: async (_account: string, method: string) => {
      if (method === "get_proposal") {
        return { status: proposalStatus, description: "Batch Zodiac configuration [mandate:abc:zodiac]" };
      }
      if (method === "active_operation") return operation.op_id;
      if (method === "get_operation") return operation;
      if (method === "client_id") return "acme";
      throw new Error(`unexpected view ${method}`);
    },
  } as unknown as NearClient;
  return { service: new GovernanceService(prisma, near), stored: () => stored };
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
});
