import { describe, expect, it } from "vitest";

import { RecoveryService, type RecoveryDeps } from "./service.js";

const NS = (iso: string) => String(BigInt(Date.parse(iso)) * 1_000_000n);

function deps(state: { recoveries: unknown[]; council: string[] }): RecoveryDeps & { drafted: string[][] } {
  const drafted: string[][] = [];
  return {
    drafted,
    contractId: "euthyna-recovery.testnet",
    daoOf: async (organizationId) => (organizationId === "org" ? "acme.sputnikv2.testnet" : null),
    councilOf: async () => state.council,
    membersProposals: async (_organizationId, members) => {
      drafted.push(members);
      return { proposals: [{ members }] };
    },
    view: async <T>(method: string, args: Record<string, unknown>) => {
      expect(args.dao_id ?? "acme.sputnikv2.testnet").toBe("acme.sputnikv2.testnet");
      const open = state.recoveries.filter((item) => (item as { state: string }).state === "Waiting");
      const answers: Record<string, unknown> = {
        enrollments_of: [{ account_id: "alice.testnet", salt: "00", identity: "11", domain: "gmail.com", enrolled_at_ns: NS("2026-11-01T00:00:00Z") }],
        recoveries_of: state.recoveries,
        delay_seconds: "172800",
        recovery: open.find((item) => (item as { lost_account_id: string }).lost_account_id === args.lost_account_id) ?? null,
      };
      return answers[method] as T;
    },
  };
}

const waiting = (ready: boolean) => ({
  lost_account_id: "alice.testnet", new_account_id: "alice2.testnet", domain: "gmail.com", state: "Waiting", ready,
  requested_at_ns: NS("2026-11-02T00:00:00Z"), not_before_ns: NS("2026-11-04T00:00:00Z"),
});

describe("seat recovery, read from the recovery contract", () => {
  it("lists enrollments and recoveries as the contract has them", async () => {
    const service = new RecoveryService(deps({ recoveries: [waiting(false)], council: ["alice.testnet", "carol.testnet"] }));
    const view = await service.list("org");
    expect(view).toMatchObject({ contractId: "euthyna-recovery.testnet", daoAccountId: "acme.sputnikv2.testnet", cancelWindowSeconds: 172_800 });
    expect(view.enrollments).toEqual([{ nearAccountId: "alice.testnet", domain: "gmail.com", enrolledAt: "2026-11-01T00:00:00.000Z" }]);
    expect(view.recoveries[0]).toMatchObject({ lostAccountId: "alice.testnet", newAccountId: "alice2.testnet", state: "waiting", ready: false, notBefore: "2026-11-04T00:00:00.000Z" });
    await expect(service.list("other")).rejects.toMatchObject({ code: "company_not_found" });
  });

  it("drafts the vote only when the contract says the recovery is ready, and the seat is still the lost account's", async () => {
    await expect(new RecoveryService(deps({ recoveries: [], council: ["alice.testnet"] })).proposals("org", "alice.testnet")).rejects.toMatchObject({ code: "recovery_not_found" });
    await expect(new RecoveryService(deps({ recoveries: [waiting(false)], council: ["alice.testnet"] })).proposals("org", "alice.testnet")).rejects.toMatchObject({ code: "too_early" });
    await expect(new RecoveryService(deps({ recoveries: [waiting(true)], council: ["carol.testnet"] })).proposals("org", "alice.testnet")).rejects.toMatchObject({ code: "seat_changed" });
    const ready = deps({ recoveries: [waiting(true)], council: ["alice.testnet", "carol.testnet"] });
    await new RecoveryService(ready).proposals("org", "alice.testnet");
    expect(ready.drafted).toEqual([["alice2.testnet", "carol.testnet"]]);
  });

  it("shows a voted recovery as done, and a cancelled one as cancelled", async () => {
    const done = await new RecoveryService(deps({ recoveries: [waiting(true)], council: ["alice2.testnet", "carol.testnet"] })).list("org");
    expect(done.recoveries[0]).toMatchObject({ state: "done", ready: false });
    const cancelled = await new RecoveryService(deps({ recoveries: [{ ...waiting(false), state: "Cancelled" }], council: ["alice.testnet"] })).list("org");
    expect(cancelled.recoveries[0]).toMatchObject({ state: "cancelled" });
  });
});
