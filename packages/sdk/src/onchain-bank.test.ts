import { describe, expect, it } from "vitest";

import { OnchainAgentClient, type DirectVault } from "./onchain.js";

const payout = { op_id: [1], beneficiary_id: 1, amount: "5000000", state: "Requested", fiat_amount: null, transfer_op_id: null, error: null };

function vault(input: { actionMs: number; recordedAfterMs: number; actionError?: Error }) {
  const started = Date.now();
  let recorded = false;
  const fake: DirectVault = {
    identity: () => ({ member: "agent.testnet", role: "payments", chain_id: 84532 }),
    prepareRequest: (async () => { throw new Error("unused"); }) as never,
    authorize: (async () => { throw new Error("unused"); }) as never,
    cancelNonce: (async () => { throw new Error("unused"); }) as never,
    view: async <T,>(method: string): Promise<T> => {
      if (method === "check_bank_payout") return { allowed: true, reason: null } as T;
      if (method === "get_bank_payout_by_reference") return ((recorded || Date.now() - started >= input.recordedAfterMs) && (recorded = true) ? payout : null) as T;
      return null as T;
    },
    action: async () => {
      await new Promise((resolve) => setTimeout(resolve, input.actionMs));
      if (input.actionError) throw input.actionError;
      return "tx-hash";
    },
  };
  return fake;
}

const client = (v: DirectVault) => {
  const c = new OnchainAgentClient(v, async () => { throw new Error("no rpc"); });
  c.payoutWaitMs = 400; c.payoutPollMs = 10;
  return c;
};

describe("bankPayout", () => {
  it("answers as soon as the vault holds the payout, without waiting for the bank signer", async () => {
    const t0 = Date.now();
    // A first view at 0 ms finds nothing (the check before the call); the payout shows up after 50 ms.
    const result = await client(vault({ actionMs: 5_000, recordedAfterMs: 50 })).bankPayout({ beneficiary: 1, amount: "5000000", reference: "R-1" });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(result).toMatchObject({ outcome: "sent", state: "Requested", note: expect.stringContaining("bank_status") });
  });

  it("returns the transaction when it ends first", async () => {
    const result = await client(vault({ actionMs: 5, recordedAfterMs: 60_000 })).bankPayout({ beneficiary: 1, amount: "5000000", reference: "R-2" });
    expect(result).toMatchObject({ outcome: "sent", nearTransactionHash: "tx-hash" });
  });

  it("while a payout is pending, gives the reason the vault would give once it is not", async () => {
    const v = vault({ actionMs: 5, recordedAfterMs: 0 });
    const view = v.view;
    v.view = async <T,>(method: string, args?: Record<string, unknown>): Promise<T> => {
      if (method === "check_bank_payout") return { allowed: false, reason: "ERR_BANK_PAYOUT_PENDING" } as T;
      if (method === "list_bank_beneficiaries") return [{ id: 1 }] as T;
      if (method === "get_bank_permission") return { max_per_payout: "10000000" } as T;
      return view<T>(method, args);
    };
    const c = client(v);
    expect(await c.bankPayout({ beneficiary: 1, amount: "20000000", reference: "R-4" })).toMatchObject({ outcome: "refused", reason: "ERR_MAX_PER_PAYOUT" });
    expect(await c.bankPayout({ beneficiary: 9, amount: "1000000", reference: "R-5" })).toMatchObject({ outcome: "refused", reason: "BeneficiaryNotAllowed" });
    expect(await c.bankPayout({ beneficiary: 1, amount: "5000000", reference: "R-6" })).toMatchObject({ outcome: "refused", reason: "ERR_BANK_PAYOUT_PENDING" });
  });

  it("still reports a key that cannot make the call", async () => {
    const result = await client(vault({ actionMs: 5, recordedAfterMs: 60_000, actionError: new Error("MethodNameMismatch") })).bankPayout({ beneficiary: 1, amount: "5000000", reference: "R-3" });
    expect(result).toMatchObject({ outcome: "refused", refusedBy: "key" });
  });
});
