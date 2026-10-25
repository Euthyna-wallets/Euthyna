import { describe, expect, it } from "vitest";

import { singleRoleTitle, summarizeRoleChanges } from "./role-summary.js";

const vote = [
  { title: "Payments budget: 1 USDC every day", details: ["Refilled up to 1 USDC every day."] },
  { title: 'Set role "payments" (1 permission)', details: ["transfer on USDC", "  · recipient must be Freelance 1", "  · amount is counted against the payments budget"] },
  { title: 'Give role "payments" to AI agent naomi-83d781-agent.mandateos.testnet', details: ["no end date, no usage limit"] },
];

describe("summarizeRoleChanges", () => {
  it("folds a role vote (budget, role, membership) into one role", () => {
    const { roles, other } = summarizeRoleChanges(vote);
    expect(other).toEqual([]);
    expect(roles).toEqual([{
      role: "payments",
      allows: ["transfer on USDC", "  · recipient must be Freelance 1", "  · amount is counted against the payments budget"],
      budgets: ["1 USDC every day"],
      holders: ["AI agent naomi-83d781-agent.mandateos.testnet"],
      removedHolders: [],
      deleted: false,
      disabled: false,
    }]);
    expect(singleRoleTitle(vote)).toBe('Role "payments"');
  });

  it("keeps unrelated changes apart and does not guess a budget's role among several", () => {
    const { roles, other } = summarizeRoleChanges([
      ...vote,
      { title: 'Set role "swaps" (1 permission)', details: [] },
      { title: "Pause all operations", details: [] },
    ]);
    expect(roles.map((role) => role.role)).toEqual(["payments", "swaps"]);
    expect(roles[0]!.budgets).toEqual([]);
    expect(other.map((change) => change.title)).toEqual(["Pause all operations", "Budget: 1 USDC every day"]);
    expect(singleRoleTitle([...vote, { title: "Pause all operations", details: [] }])).toBeNull();
  });
});
