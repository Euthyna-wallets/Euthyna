import { BASE_SEPOLIA, compileRole } from "@mandateos/sdk/roles";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forkedLawOf, lawForCompany, rememberPendingLaw, roleBuilderPath, RUGGY_LAW } from "./onboarding-law.js";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
    clear: () => items.clear(),
    key: (index: number) => [...items.keys()][index] ?? null,
    get length() { return items.size; },
  };
}

describe("Ruggy's law, forked from /rob", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = memoryStorage();
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("is only known by its id", () => {
    expect(forkedLawOf("ruggy")).toBe(RUGGY_LAW);
    expect(forkedLawOf("toString")).toBeNull();
    expect(forkedLawOf(null)).toBeNull();
  });

  it("compiles to Ruggy's rules once the founders add a supplier: TestUSDC, 0.1 to 2 a payment, 10 a day", () => {
    const block = { ...RUGGY_LAW.block, receivers: [{ accountId: "my-supplier.testnet", label: "My supplier" }] };
    const changes = compileRole({
      name: "payments",
      guardRequired: false,
      blocks: [{ kind: "near-transfer", token: block.token, receivers: block.receivers, budget: { amount: block.amount, periodDays: block.periodDays }, maxPerTransfer: block.maxPerTransfer, minPerTransfer: block.minPerTransfer }],
      members: [],
    }, BASE_SEPOLIA);
    const near = changes.find((change) => "SetNearPermissions" in change) as { SetNearPermissions: { permissions: Array<Record<string, unknown>> } } | undefined;
    expect(near?.SetNearPermissions.permissions).toEqual([
      expect.objectContaining({ token: "test-ft-v4.mandateos-root-20261021.testnet", receivers: ["my-supplier.testnet"], min_per_transfer: "100000", max_per_transfer: "2000000" }),
    ]);
    const budget = changes.find((change) => "SetAllowance" in change) as { SetAllowance: { balance: string; period_ns?: string } } | undefined;
    expect(budget?.SetAllowance).toMatchObject({ balance: "10000000" });
  });

  it("starts with no recipient: the founders list their own", () => {
    expect(RUGGY_LAW.block.receivers).toEqual([]);
    expect(RUGGY_LAW.banner).toBe("Ruggy's law, pre-filled. Change anything.");
  });

  it("waits for the company being created, then belongs to it", () => {
    rememberPendingLaw(RUGGY_LAW, 1_000);
    expect(lawForCompany("org-1", 2_000)).toBe(RUGGY_LAW);
    // Taken by the first company: a second one opens empty.
    expect(lawForCompany("org-2", 3_000)).toBeNull();
    expect(lawForCompany("org-1", 4_000)).toBe(RUGGY_LAW);
  });

  it("does not wait more than a day", () => {
    rememberPendingLaw(RUGGY_LAW, 0);
    expect(lawForCompany("org-1", 25 * 3_600_000)).toBeNull();
  });

  it("is passed to the role builder next to the job", () => {
    expect(roleBuilderPath("payments", "payments", RUGGY_LAW)).toBe("/roles?new=1&role=payments&job=payments&law=ruggy");
    expect(roleBuilderPath("treasury", null, null)).toBe("/roles?new=1&role=treasury");
  });
});
