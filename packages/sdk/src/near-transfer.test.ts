import { describe, expect, it } from "vitest";

import { BASE_SEPOLIA, budgetsOf, compileRole, describeChange, NEAR_TESTNET_TOKENS, validNearAccountId, type RoleBlock, type RuleChange } from "./roles.js";

const USDC = NEAR_TESTNET_TOKENS[0]!.accountId;
const CARD = "card-larry.euthyna.testnet";

const block = (overrides: Partial<Extract<RoleBlock, { kind: "near-transfer" }>> = {}): RoleBlock => ({
  kind: "near-transfer",
  token: "USDC",
  receivers: [{ accountId: CARD, label: "Larry's card" }],
  budget: { amount: "10", periodDays: 1 },
  maxPerTransfer: "5",
  ...overrides,
});
const compile = (blocks: RoleBlock[], extra: { clearNearPermissions?: boolean } = {}) =>
  compileRole({ name: "card-refill", blocks, members: [], ...extra }, BASE_SEPOLIA);
const nearOf = (changes: RuleChange[]) =>
  changes.find((change) => "SetNearPermissions" in change) as Extract<RuleChange, { SetNearPermissions: unknown }> | undefined;

describe("NEAR transfer role", () => {
  it("budgets in token units, with the default floor and the cap", () => {
    const changes = compile([block()]);
    const budget = changes.find((change) => "SetAllowance" in change) as Extract<RuleChange, { SetAllowance: unknown }>;
    expect(budget.SetAllowance.balance).toBe("10000000");
    const [permission] = nearOf(changes)!.SetNearPermissions.permissions;
    expect(permission).toEqual({
      token: USDC,
      receivers: [CARD],
      allowance: budget.SetAllowance.key,
      // Default floor: budget / 100, so at most 100 transfers a day.
      min_per_transfer: "100000",
      max_per_transfer: "5000000",
    });
  });

  it("keeps the default floor at or below the cap", () => {
    const [permission] = nearOf(compile([block({ budget: { amount: "1000", periodDays: 1 }, maxPerTransfer: "5" })]))!.SetNearPermissions.permissions;
    expect(permission!.min_per_transfer).toBe("5000000");
  });

  it("registers the vault on the token before the permissions, and creates the role", () => {
    const changes = compile([block(), block({ receivers: [{ accountId: "bob.testnet", label: "Bob" }] })]);
    const kinds = changes.map((change) => Object.keys(change)[0]);
    expect(kinds.filter((kind) => kind === "NearStorageDeposit")).toHaveLength(1);
    expect(kinds.indexOf("NearStorageDeposit")).toBeLessThan(kinds.indexOf("SetNearPermissions"));
    expect(kinds).toContain("SetRole");
    expect(nearOf(changes)!.SetNearPermissions.permissions).toHaveLength(2);
  });

  it("emits nothing NEAR for roles that do not use it, unless asked to clear", () => {
    const evm = [{ kind: "wrap", budget: { amount: "0.1", periodDays: 1 } }] as RoleBlock[];
    expect(nearOf(compile(evm))).toBeUndefined();
    expect(nearOf(compile(evm, { clearNearPermissions: true }))!.SetNearPermissions.permissions).toEqual([]);
  });

  it("refuses unsafe or malformed blocks", () => {
    expect(() => compile([block({ receivers: [] })])).toThrow(/NEAR receiver/);
    expect(() => compile([block({ receivers: [{ accountId: "Not An Account", label: "x" }] })])).toThrow(/not a NEAR account id/);
    expect(() => compile([block({ minPerTransfer: "0" })])).toThrow(/must be positive/);
    expect(() => compile([block({ minPerTransfer: "6" })])).toThrow(/above the largest/);
    expect(() => compile([block({ maxPerTransfer: "11" })])).toThrow(/above the budget/);
    expect(() => compile([block({ token: "DOGE" })])).toThrow(/unknown NEAR token/);
    expect(() => compile([block({ maxPerTransfer: "5.0000009" })])).toThrow(/too precise/);
    expect(() => compile([block({ receivers: Array.from({ length: 33 }, (_, i) => ({ accountId: `r${i}.testnet`, label: "r" })) })])).toThrow(/at most 32/);
  });

  it("reads back in plain English", () => {
    const changes = compile([block()]);
    const budgets = budgetsOf(changes, BASE_SEPOLIA);
    const near = describeChange(nearOf(changes)!, { profile: BASE_SEPOLIA, budgets });
    expect(near.title).toBe('Let role "card-refill" send tokens on NEAR');
    expect(near.details[0]).toBe(`Send USDC on NEAR to ${CARD}, from 0.1 USDC to 5 USDC per transfer, within budget "card-refill NEAR transfers"`);
    const budget = changes.find((change) => "SetAllowance" in change)!;
    expect(describeChange(budget, { profile: BASE_SEPOLIA, budgets }).title).toContain("10 USDC every day");
    const deposit = changes.find((change) => "NearStorageDeposit" in change)!;
    expect(describeChange(deposit, { profile: BASE_SEPOLIA, budgets }).title).toBe("Register the vault on USDC (NEAR)");
  });

  it("knows NEAR account ids", () => {
    expect(validNearAccountId("card-larry.euthyna.testnet")).toBe(true);
    expect(validNearAccountId(USDC)).toBe(true);
    expect(validNearAccountId("a")).toBe(false);
    expect(validNearAccountId("bad..dots.testnet")).toBe(false);
    expect(validNearAccountId("UPPER.testnet")).toBe(false);
  });
});
