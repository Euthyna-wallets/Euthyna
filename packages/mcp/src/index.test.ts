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
      gasQuote: async () => ({
        gas: {
          gasLimit: "200000",
          maxFeePerGas: "20000000000",
          maxPriorityFeePerGas: "1000000000",
          sufficientBalance: true,
        },
        warnings: [],
      }),
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
    })).resolves.toMatchObject({ outcome: "authorized" });
    await expect(tools.status({ opId: `0x${"01".repeat(32)}` })).resolves.toEqual({ status: "Broadcast" });
    await expect(tools.cancel({ opId: `0x${"01".repeat(32)}`    })).resolves.toMatchObject({ nearTransactionHash: "near-cancel" });
    expect(calls).toEqual(["cancel_nonce", "record_cancellation"]);
  });

  it("checks transfers and calls, and reads the mandate", async () => {
    const checked: Array<Record<string, unknown>> = [];
    const vault: VaultGateway = {
      prepare: async () => { throw new Error("check must not prepare"); },
      authorize: async () => { throw new Error("check must not authorize"); },
      cancelNonce: async () => "",
    };
    const api: AgentApiGateway = {
      gasQuote: async () => { throw new Error("check must not quote gas"); },
      requestVisa: async () => ({ status: 500, body: {} }),
      recordAuthorization: async () => ({}),
      recordCancellation: async () => ({}),
      status: async () => ({}),
      check: async (request) => {
        checked.push(request as unknown as Record<string, unknown>);
        return { allowed: false, refusedBy: "guard", reason: "GUARD:guard_refused:x", explanation: "Guard: x", requires_delay: false, requires_cosign: false };
      },
      mandate: async () => ({ role: "suppliers", budgets: [] }),
    };
    const tools = new MandateMcpTools(new MandateAgentClient(vault, api));
    await expect(tools.check({
      token: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      amount: "5",
      reference: "INV-2",
    })).resolves.toMatchObject({ allowed: false, refusedBy: "guard" });
    expect(checked[0]).toMatchObject({ chain_id: 84532, allowance_amount: "5", value: "0", reference: "INV-2" });
    await tools.check({ to: "0x3333333333333333333333333333333333333333", data: "0x617ba037", allowanceAmount: "10", chainId: 11155111, reference: "AAVE-1" });
    expect(checked[1]).toMatchObject({ chain_id: 11155111, calldata: [0x61, 0x7b, 0xa0, 0x37], allowance_amount: "10" });
    await expect(tools.check({ reference: "nothing" })).rejects.toThrow(/token \+ recipient \+ amount/);
    await expect(tools.mandate()).resolves.toEqual({ role: "suppliers", budgets: [] });
  });
});

