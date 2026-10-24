import { describe, expect, it } from "vitest";
import type { Hex } from "viem";

import fixture from "./fixtures/presets.json" with { type: "json" };
import {
  BASE_SEPOLIA,
  budgetsOf,
  compileRole,
  decodeVaultCalls,
  describeChange,
  describeVaultCall,
  erc20ApproveSheet,
  erc20TransferSheet,
  proposalArgs,
  uniswapV2Sheet,
  uniswapV3Sheet,
  type RuleChange,
  type Sheet,
} from "./roles.js";

const hex20 = (byte: string) => `0x${byte.repeat(20)}` as Hex;
const USDC = hex20("41");
const A = hex20("aa");
const B = hex20("bb");
const V3 = hex20("94");
const V2 = hex20("16");
const SUPPLIER = hex20("a7");
const KEY = Array(32).fill(0x5a);

function normalize(sheet: Sheet) {
  return {
    target: sheet.target.toLowerCase(),
    selector: sheet.selector,
    conditions: sheet.conditions.map(({ parent, paramType, operator, compValue }) => ({ compValue: compValue.toLowerCase(), operator, paramType, parent })),
  };
}

describe("protocol sheets match omniroles-conditions::presets", () => {
  const cases: Record<string, Sheet> = {
    approve: erc20ApproveSheet(USDC, [V3, V2], 10_000_000_000n),
    approveSingle: erc20ApproveSheet(USDC, [V3], 1n),
    transfer: erc20TransferSheet(USDC, [SUPPLIER], KEY),
    transferMany: erc20TransferSheet(USDC, [SUPPLIER, A], KEY),
    uniswapV3: uniswapV3Sheet(V3, USDC, [A, B], KEY),
    uniswapV3Single: uniswapV3Sheet(V3, USDC, [A], KEY),
    uniswapV2: uniswapV2Sheet(V2, [[USDC, A], [USDC, B]], KEY),
    uniswapV2Single: uniswapV2Sheet(V2, [[USDC, A]], KEY),
  };
  for (const [name, sheet] of Object.entries(cases)) {
    it(name, () => {
      expect(normalize(sheet)).toEqual((fixture as Record<string, unknown>)[name]);
    });
  }
});

const TEST_USDC = BASE_SEPOLIA.tokens[0]!.address;
const WETH = BASE_SEPOLIA.tokens[2]!.address;

function swapRole(): RuleChange[] {
  return compileRole({
    name: "treasury",
    blocks: [
      { kind: "payments", token: TEST_USDC, recipients: [{ address: SUPPLIER, label: "Studio Pixel" }], budget: { amount: "1000", periodDays: 30 } },
      { kind: "swap", tokenIn: TEST_USDC, tokensOut: [WETH], protocols: ["uniswap-v3", "uniswap-v2"], budget: { amount: "100000", periodDays: 30 }, maxApproval: "10000" },
    ],
    members: [{ accountId: "swap-bot.mandateos.testnet", kind: "Agent", maxUses: 50 }],
  }, BASE_SEPOLIA);
}

describe("compileRole", () => {
  it("creates budgets, the role and its members", () => {
    const changes = swapRole();
    expect(changes.map((change) => Object.keys(change)[0])).toEqual(["SetAllowance", "SetAllowance", "SetRole", "GrantMembership"]);
    const allowance = changes[0] as Extract<RuleChange, { SetAllowance: unknown }>;
    expect(allowance.SetAllowance.balance).toBe("1000000000");
    expect(allowance.SetAllowance.period_ns).toBe(30 * 86_400_000_000_000);
    const role = changes[2] as Extract<RuleChange, { SetRole: unknown }>;
    // transfer + approve + V3 + V2
    expect(role.SetRole.config.permissions).toHaveLength(4);
    expect(role.SetRole.config.operation_delay_threshold).toBeNull();
    expect(role.SetRole.config.co_sign_threshold).toBeNull();
  });

  it("refuses invalid drafts", () => {
    expect(() => compileRole({ name: "Bad Name", blocks: [], members: [] }, BASE_SEPOLIA)).toThrow(/role name/);
    expect(() => compileRole({ name: "ok", blocks: [], members: [] }, BASE_SEPOLIA)).toThrow(/block/);
    expect(() => compileRole({
      name: "ok",
      blocks: [{ kind: "swap", tokenIn: TEST_USDC, tokensOut: [TEST_USDC], protocols: ["uniswap-v3"], budget: { amount: "1", periodDays: 1 }, maxApproval: "1" }],
      members: [],
    }, BASE_SEPOLIA)).toThrow(/change token/);
  });
});

describe("descriptions", () => {
  const changes = swapRole();
  const context = { profile: BASE_SEPOLIA, labels: { [SUPPLIER]: "Studio Pixel" }, budgets: budgetsOf(changes, BASE_SEPOLIA) };

  it("names budgets by role and token", () => {
    expect(describeChange(changes[0]!, context).title).toBe("Treasury payments budget: 1,000 TestUSDC every 30 days");
    expect(describeChange(changes[1]!, context).title).toBe("Treasury swaps budget: 100,000 TestUSDC every 30 days");
  });

  it("explains every condition of the role", () => {
    const role = describeChange(changes[2]!, context);
    expect(role.title).toBe('Set role "treasury" (4 permissions)');
    const text = role.details.join("\n");
    expect(text).toContain("transfer on TestUSDC");
    expect(text).toContain("recipient must be Studio Pixel");
    expect(text).toContain("amount is counted against the treasury payments budget");
    expect(text).toContain("spender must be one of: Uniswap V3 router, Uniswap V2 router");
    expect(text).toContain("amount at most 10,000 TestUSDC");
    expect(text).toContain("token sold must be TestUSDC");
    expect(text).toContain("token bought must be WETH");
    expect(text).toContain("recipient must be the company wallet");
    expect(text).toContain("minimum received must be set (not zero)");
    expect(text).toContain("route must be an approved route");
  });

  it("describes members", () => {
    expect(describeChange(changes[3]!, context)).toEqual({
      title: 'Give role "treasury" to AI agent swap-bot.mandateos.testnet',
      details: ["no end date, at most 50 operations"],
    });
  });
});

describe("DAO proposals", () => {
  it("round-trips vault calls through a Sputnik FunctionCall proposal", () => {
    const changes = swapRole();
    const calls = [{ method: "request_wallet" as const, chainId: 84532 }, ...changes.map((change) => ({ method: "queue_rule_change" as const, change }))];
    const args = proposalArgs("acme-v.mandateos.testnet", "Create role treasury", calls);
    expect(args.proposal.description).toBe("[mandateos] Create role treasury");
    expect(args.proposal.kind.FunctionCall.actions).toHaveLength(5);
    const decoded = decodeVaultCalls(args.proposal.kind, "acme-v.mandateos.testnet");
    expect(decoded).toEqual(calls);
    expect(decodeVaultCalls(args.proposal.kind, "other.testnet")).toBeNull();
    expect(describeVaultCall(decoded![0]!, { profile: BASE_SEPOLIA }).title).toBe("Create the company wallet on Base Sepolia");
  });
});
