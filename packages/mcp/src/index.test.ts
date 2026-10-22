import { describe, expect, it } from "vitest";

import type { AgentApiGateway, VaultGateway } from "@mandateos/sdk";
import { MandateAgentClient } from "@mandateos/sdk";

import { MandateMcpTools } from "./index.js";

const opId = Array(32).fill(1) as number[];

describe("MandateMcpTools", () => {
  it("exposes pay, status and agent cancellation over the SDK", async () => {
    const calls: string[] = [];
    const vault: VaultGateway = {
      prepare: async () => ({ op_id: opId, state: "Prepared" }),
      authorize: async () => "near-authorize",
      cancelNonce: async () => {
        calls.push("cancel_nonce");
        return "near-cancel";
      },
    };
    const api: AgentApiGateway = {
      requestVisa: async () => ({ status: 200, body: { visa: { op_id: opId }, signature: "sig" } }),
      recordAuthorization: async () => ({}),
      recordCancellation: async () => {
        calls.push("record_cancellation");
        return {};
      },
      status: async () => ({ status: "Broadcast" }),
    };
    const tools = new MandateMcpTools(new MandateAgentClient(vault, api));
    await expect(tools.pay({
      token: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      amount: "100",
      reference: "INV-1",
      gasLimit: "200000",
      maxFeePerGas: "20000000000",
      maxPriorityFeePerGas: "1000000000",
    })).resolves.toMatchObject({ outcome: "authorized" });
    await expect(tools.status({ opId: `0x${"01".repeat(32)}` })).resolves.toEqual({ status: "Broadcast" });
    await expect(tools.cancel({
      opId: `0x${"01".repeat(32)}`,
      gasLimit: "21000",
      maxFeePerGas: "30000000000",
      maxPriorityFeePerGas: "2000000000",
    })).resolves.toMatchObject({ nearTransactionHash: "near-cancel" });
    expect(calls).toEqual(["cancel_nonce", "record_cancellation"]);
  });
});
