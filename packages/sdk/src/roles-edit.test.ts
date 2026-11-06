import { describe, expect, it } from "vitest";

import { allowanceKey, BASE_SEPOLIA, compileRole, hexOf, roleDraftFromChain, unchangedBudgets, withSealedOrdersMember, type ChainRole, type RoleDraft, type RuleChange } from "./roles.js";

const USDC = BASE_SEPOLIA.tokens.find((token) => token.symbol === "USDC")!.address;
const WETH = BASE_SEPOLIA.weth!;

/** What the vault holds once a draft's changes are executed. */
function onChain(draft: RoleDraft, extra: Partial<ChainRole> = {}): ChainRole {
  const changes = compileRole(draft, BASE_SEPOLIA);
  const pick = <K extends string>(kind: K) => changes.filter((change) => kind in change) as Array<Record<K, any>>;
  return {
    name: draft.name,
    config: pick("SetRole")[0]!.SetRole.config,
    allowances: Object.fromEntries(pick("SetAllowance").map((change) => [hexOf(change.SetAllowance.key).toLowerCase(), { refill: change.SetAllowance.refill, period_ns: change.SetAllowance.period_ns }])),
    near: pick("SetNearPermissions")[0]?.SetNearPermissions.permissions ?? [],
    solana: pick("SetSolanaPermissions")[0]?.SetSolanaPermissions.permissions ?? [],
    ...extra,
  };
}

const full: RoleDraft = {
  name: "desk",
  guardRequired: false,
  suppliersOnly: false,
  blocks: [
    { kind: "payments", token: USDC, recipients: [{ address: "0x1111111111111111111111111111111111111111", label: "" }, { address: "0x2222222222222222222222222222222222222222", label: "" }], budget: { amount: "100", periodDays: 30 } },
    { kind: "swap", tokenIn: USDC, tokensOut: [WETH], protocols: ["uniswap-v3", "uniswap-v2"], budget: { amount: "10", periodDays: 1 }, maxApproval: "20" },
    { kind: "wrap", budget: { amount: "0.01", periodDays: 1 } },
    { kind: "lending", protocol: "aave-v3", token: BASE_SEPOLIA.lending!["aave-v3"]!.assets[0]!, budget: { amount: "1", periodDays: 30 }, maxApproval: "1" },
    { kind: "near-transfer", token: "USDC", receivers: [{ accountId: "card.agent.testnet", label: "" }], budget: { amount: "10", periodDays: 1 }, maxPerTransfer: "5" },
    { kind: "solana-transfer", token: null, recipients: [{ address: "11111111111111111111111111111112", label: "" }], budget: { amount: "0.1", periodDays: 1 } },
  ],
  members: [],
};

const strip = (draft: RoleDraft) => ({ ...draft, gas: undefined, members: [] });

describe("editing a role", () => {
  it("rebuilds the draft of every kind of block from the vault, and it compiles back to the same role", () => {
    const rebuilt = roleDraftFromChain(onChain(full), BASE_SEPOLIA);
    expect(rebuilt).not.toBeNull();
    expect(strip(rebuilt!)).toEqual(strip(full));
  });

  it("rebuilds a suppliers-only transfer role and a revenue role", () => {
    const suppliers: RoleDraft = { name: "pay", suppliersOnly: true, blocks: [{ kind: "payments", token: USDC, recipients: [], budget: { amount: "5", periodDays: 7 } }], members: [] };
    expect(strip(roleDraftFromChain(onChain(suppliers), BASE_SEPOLIA)!)).toEqual(strip({ ...suppliers, guardRequired: false }));
    const revenue: RoleDraft = { name: "rev", blocks: [{ kind: "share-revenue", sharesAccountId: "acme.shares.testnet", budget: { amount: "0.01", periodDays: 7 } }], members: [] };
    expect(roleDraftFromChain(onChain(revenue), BASE_SEPOLIA)).toBeNull(); // shares account unknown
    expect(strip(roleDraftFromChain(onChain(revenue, { sharesAccountId: "acme.shares.testnet" }), BASE_SEPOLIA)!)).toEqual(strip({ ...revenue, guardRequired: false, suppliersOnly: false }));
  });

  it("refuses to edit a role it cannot rebuild exactly", () => {
    const chain = onChain(full);
    expect(roleDraftFromChain({ ...chain, config: { ...chain.config, operation_delay_ns: 5 } }, BASE_SEPOLIA)).toBeNull();
    expect(roleDraftFromChain({ ...chain, name: "other" }, BASE_SEPOLIA)).toBeNull();
    const [firstKey] = Object.keys(chain.allowances);
    expect(roleDraftFromChain({ ...chain, allowances: { ...chain.allowances, [firstKey!]: { refill: "1", period_ns: 1 } } }, BASE_SEPOLIA)).not.toEqual(full);
  });

  it("keeps the budgets that did not change, so an edit does not refill them, and revokes removed members", () => {
    const after: RoleDraft = { ...full, blocks: full.blocks.map((block, index) => (index === 1 ? { ...block, budget: { amount: "15", periodDays: 1 } } : block)) };
    const keep = unchangedBudgets(full, after, BASE_SEPOLIA);
    expect(keep).toHaveLength(full.blocks.length - 1);
    expect(keep).not.toContain(hexOf(allowanceKey("desk", "swap-2")).toLowerCase());
    const changes = compileRole({ ...after, keepBudgets: keep, revokeMembers: ["old.testnet"], clearSolanaPermissions: true }, BASE_SEPOLIA);
    const allowances = changes.filter((change): change is Extract<RuleChange, { SetAllowance: unknown }> => "SetAllowance" in change);
    expect(allowances.map((change) => change.SetAllowance.refill)).toEqual(["15000000"]);
    expect(changes).toContainEqual({ RevokeMembership: { role: "desk", member: "old.testnet" } });
  });

  it("clears Solana rights when the edited role has none", () => {
    const changes = compileRole({ name: "desk", blocks: [full.blocks[2]!], members: [], clearSolanaPermissions: true }, BASE_SEPOLIA);
    expect(changes).toContainEqual({ SetSolanaPermissions: { role: "desk", permissions: [] } });
  });

  it("adds the sealed-orders contract to a role that allows them, once", () => {
    const sealed: RoleDraft = { name: "desk", blocks: [{ ...(full.blocks[1] as Extract<RoleDraft["blocks"][number], { kind: "swap" }>), sealedOrders: true }], members: [] };
    expect(withSealedOrdersMember(sealed, "sealed.testnet", false).members).toEqual([{ accountId: "sealed.testnet", kind: "Agent", maxUses: null }]);
    expect(withSealedOrdersMember(sealed, "sealed.testnet", true).members).toEqual([]);
    expect(withSealedOrdersMember(full, null, false)).toBe(full);
    expect(() => withSealedOrdersMember(sealed, null, false)).toThrow(/not configured/);
  });
});
