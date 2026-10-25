import { describe, expect, it } from "vitest";
import { getAddress, toFunctionSelector, type Hex } from "viem";

import fixture from "./fixtures/presets.json" with { type: "json" };
import {
  BASE_SEPOLIA,
  budgetsOf,
  compileRole,
  councilPolicy,
  decodeVaultCalls,
  describePolicyChange,
  describeSharesProposal,
  formatNear,
  hexOf,
  nearRecipient,
  SELECTORS,
  shareRevenueCall,
  stringHash,
  hasShareholdersRole,
  parseNear,
  revenueProposalKind,
  shareholdersRole,
  sharesInitArgs,
  sharesProposalKinds,
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

const TEST_USDC = BASE_SEPOLIA.tokens.find((token) => token.symbol === "TestUSDC")!.address;
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
    expect(text).toContain("route must be TestUSDC → WETH");
  });

  it("prints full addresses for server-provided labels when asked", () => {
    const text = describeChange(changes[2]!, { ...context, fullAddresses: true }).details.join("\n");
    expect(text).toContain(`recipient must be Studio Pixel (${getAddress(SUPPLIER)})`);
    expect(text).toContain("spender must be one of: Uniswap V3 router, Uniswap V2 router");
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

describe("describeCall", async () => {
  const { describeCall } = await import("./roles.js");
  const { encodeFunctionData, erc20Abi } = await import("viem");
  const context = { profile: BASE_SEPOLIA, labels: { [SUPPLIER]: "Studio Pixel" } };
  it("reads transfers and approvals", () => {
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [SUPPLIER, 250_000_000n] });
    expect(describeCall(TEST_USDC, transfer, 0n, context)).toBe("transfer 250 TestUSDC to Studio Pixel");
    const drain = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: ["0x000000000000000000000000000000000000dEaD", 2n ** 256n - 1n] });
    expect(describeCall(TEST_USDC, drain, 0n, context)).toBe("approve 0x0000…dEaD (not a registered supplier) to spend an unlimited amount of TestUSDC");
  });
  it("reads a bridge transfer to a NEAR account through the Omni Bridge", async () => {
    const { parseAbi } = await import("viem");
    const data = encodeFunctionData({
      abi: parseAbi(["function initTransfer(address tokenAddress, uint128 amount, uint128 fee, uint128 nativeFee, string recipient, string message)"]),
      functionName: "initTransfer",
      args: ["0x0000000000000000000000000000000000000000", 1_000_000_000_000_000n, 0n, 9_009_498_255_508n, "near:shares.mandateos.testnet", ""],
    });
    expect(describeCall("0xa56b860017152cD296ad723E8409Abd6e5D86d4d", data, 1_009_009_498_255_508n, context))
      .toBe("bridge 0.001 ETH to NEAR account shares.mandateos.testnet through NEAR Omni Bridge (relayer fee 0.000009009498255508 ETH)");
  });
});

describe("DAO members", async () => {
  const { councilPolicy, describePolicyChange, membersProposalArgs } = await import("./roles.js");
  const settings = { proposalBond: "100000000000000000000000", proposalPeriodNs: "604800000000000" };
  it("builds the standard council policy with a two-thirds threshold", () => {
    const policy = councilPolicy(["a.testnet", "b.testnet", "c.testnet", "d.testnet"], settings);
    expect(policy.default_vote_policy.threshold).toBe("3");
    const described = describePolicyChange(membersProposalArgs(policy, "Change members").proposal.kind)!;
    expect(described.members).toEqual(["a.testnet", "b.testnet", "c.testnet", "d.testnet"]);
    expect(described.standard).toBe(true);
    expect(described.details[0]).toBe("a decision will need 3 of 4 approvals");
  });
  it("flags a policy that would hand control to someone else", () => {
    const policy = councilPolicy(["a.testnet", "b.testnet", "c.testnet"], settings);
    policy.roles.push({ name: "all", kind: "Everyone", permissions: ["*:*"], vote_policy: {} });
    const described = describePolicyChange({ ChangePolicy: { policy } })!;
    expect(described.standard).toBe(false);
    expect(described.details.join("\n")).toContain("extra permissions: *:*");
  });
  it("refuses fewer than three members or duplicates", () => {
    expect(() => councilPolicy(["a.testnet", "b.testnet"], settings)).toThrow(/three/);
    expect(() => councilPolicy(["a.testnet", "a.testnet", "b.testnet"], settings)).toThrow(/twice/);
  });
});

describe("DAO transactions", async () => {
  const { describeDaoTransactions, proposalArgs: args, decodeVaultCalls: decode } = await import("./roles.js");
  const { encodeFunctionData, erc20Abi, parseAbi } = await import("viem");
  const pool = "0x07ea79f68b2b3df564d0a34f8e19d9b1e339814b" as Hex;
  const wallet = "0x061aBa709C5A8D910010B7FaC3D0513668A67ae9" as Hex;
  const transactions = [
    { chainId: 84532, to: TEST_USDC, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool, 10_000_000n] }), gasLimit: "80000", maxFeePerGas: "100000000", maxPriorityFeePerGas: "1000000" },
    { chainId: 84532, to: pool, value: "0", data: encodeFunctionData({ abi: parseAbi(["function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)"]), functionName: "supply", args: [TEST_USDC, 10_000_000n, wallet, 0] }), gasLimit: "300000", maxFeePerGas: "100000000", maxPriorityFeePerGas: "1000000" },
  ];

  it("round-trips through a Sputnik proposal", () => {
    const proposal = args("vault.testnet", "Deposit in Aave", [{ method: "submit_transactions", transactions }]);
    expect(decode(proposal.proposal.kind, "vault.testnet")).toEqual([{ method: "submit_transactions", transactions: transactions.map((item) => ({ ...item, to: getAddress(item.to) })) }]);
  });

  it("spells out each call, its target and its fees", () => {
    const text = describeDaoTransactions(transactions, { profile: BASE_SEPOLIA, labels: { [wallet]: "company wallet" }, fullAddresses: true });
    expect(text.title).toBe("Send 2 transactions from the company wallet");
    const details = text.details.join("\n");
    expect(details).toContain(`1. approve ${getAddress(pool)} (not a registered supplier) to spend 10 TestUSDC on Base Sepolia`);
    expect(details).toContain(`2. deposit 10 TestUSDC into ${getAddress(pool)} (unknown contract) for company wallet (${wallet}) on Base Sepolia`);
    expect(details).toContain("network fee at most 0.00003 ETH");
  });
});

describe("shares governance", () => {
  const settings = { proposalBond: "1", proposalPeriodNs: "2" };

  it("keeps the shareholders role standard when members change", () => {
    const policy = councilPolicy(["a.testnet", "b.testnet", "c.testnet"], settings, { shareholders: true });
    const described = describePolicyChange({ ChangePolicy: { policy } });
    expect(described?.standard).toBe(true);
    expect(described?.details).toContain("shareholders keep their vote on company calls and transfers");
  });

  it("recognizes the role whatever order Sputnik returns it in", () => {
    const role = shareholdersRole();
    const shuffled = { ...role, permissions: [...role.permissions].reverse(), vote_policy: { transfer: role.vote_policy.transfer, call: role.vote_policy.call } };
    expect(hasShareholdersRole({ roles: [shuffled] })).toBe(true);
    expect(hasShareholdersRole({ roles: [{ ...role, permissions: [...role.permissions, "policy:VoteApprove"] }] })).toBe(false);
  });

  it("flags a role that is not the shareholders template", () => {
    const role = { ...shareholdersRole(), permissions: ["*:VoteApprove"] };
    const described = describeSharesProposal({ ChangePolicyAddOrUpdateRole: { role } }, "acme-shares.testnet");
    expect(described?.details[0]).toContain("⚠");
    const policy = { ...councilPolicy(["a.testnet", "b.testnet", "c.testnet"], settings), roles: [councilPolicy(["a.testnet", "b.testnet", "c.testnet"], settings).roles[0]!, role] };
    expect(describePolicyChange({ ChangePolicy: { policy } })?.standard).toBe(false);
  });

  it("describes the setup votes and a revenue share", () => {
    const [staking, shareholders] = sharesProposalKinds("acme-shares.testnet");
    expect(describeSharesProposal(staking!.kind, "acme-shares.testnet")?.details).not.toContain("⚠ this is not the company's shares contract");
    expect(describeSharesProposal(staking!.kind, "other.testnet")?.details).toContain("⚠ this is not the company's shares contract");
    expect(describeSharesProposal(shareholders!.kind, "acme-shares.testnet")?.title).toBe("Shareholders vote on company calls and transfers");
    const revenue = revenueProposalKind("acme-shares.testnet", parseNear("2.5"));
    expect(describeSharesProposal(revenue, "acme-shares.testnet")?.title).toBe("Share 2.5 NEAR with shareholders");
    expect(describeSharesProposal(revenue, "someone-else.testnet")).toBeNull();
  });

  it("checks the init arguments", () => {
    const base = { name: "Acme", symbol: "ACME", totalSupply: 1000, pricePerShareYocto: parseNear("0.1"), unlockPeriodNs: "1", epochNs: "3600000000000", revenueToken: null, allocations: [["a.testnet", 100]] as Array<[string, number]> };
    expect(sharesInitArgs("dao.testnet", base).allocations).toEqual([["a.testnet", "100"]]);
    expect(() => sharesInitArgs("dao.testnet", { ...base, symbol: "acme" })).toThrow();
    expect(() => sharesInitArgs("dao.testnet", { ...base, allocations: [["a.testnet", 1001]] })).toThrow();
    expect(formatNear(parseNear("0.1"))).toBe("0.1 NEAR");
  });
});

describe("share revenue role", () => {
  const shares = "acme-ai-shares.mandateos.testnet";
  const draft = { name: "revenue", blocks: [{ kind: "share-revenue" as const, sharesAccountId: shares, budget: { amount: "0.01", periodDays: 7 } }], members: [] };

  it("uses the real initTransfer selector", () => {
    expect(SELECTORS.initTransfer).toBe(toFunctionSelector("initTransfer(address,uint128,uint128,uint128,string,string)"));
  });

  it("allows ETH to the shares contract only, counted in ETH", () => {
    const changes = compileRole(draft, BASE_SEPOLIA);
    const role = changes.find((change) => "SetRole" in change) as Extract<RuleChange, { SetRole: unknown }>;
    const permission = role.SetRole.config.permissions[0]!;
    expect(permission.allow_value).toBe(true);
    expect(hexOf(permission.target).toLowerCase()).toBe(BASE_SEPOLIA.omniBridge!.toLowerCase());
    expect(role.SetRole.config.gas_limit).toBe("1000000");
    const allowance = changes.find((change) => "SetAllowance" in change) as Extract<RuleChange, { SetAllowance: unknown }>;
    expect(allowance.SetAllowance.balance).toBe("10000000000000000");
    const call = shareRevenueCall(BASE_SEPOLIA.omniBridge!, shares, 5_000_000_000_000_000n, 4_249_821_508_237n);
    expect(call.value).toBe((5_000_000_000_000_000n + 4_249_821_508_237n).toString());
    expect(call.data.startsWith(SELECTORS.initTransfer)).toBe(true);
  });

  it("describes the role in plain words", () => {
    const changes = compileRole(draft, BASE_SEPOLIA);
    const labels = { [stringHash(nearRecipient(shares))]: `${nearRecipient(shares)} (company shares)` };
    const context = { profile: BASE_SEPOLIA, labels, budgets: budgetsOf(changes, BASE_SEPOLIA) };
    const text = JSON.stringify(changes.map((change) => describeChange(change, context)));
    expect(text).toContain("token must be ETH itself (native)");
    expect(text).toContain(`NEAR recipient must be near:${shares} (company shares)`);
    expect(text).toContain("message must be empty");
    expect(text).toContain("bridge fee at most 0.001 ETH");
    expect(text).toContain("ETH sent is counted against the revenue budget");
  });
});
