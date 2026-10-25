/**
 * OmniRoles role builder and rule descriptions.
 *
 * - Builds vault rule changes (`SetAllowance`, `SetRole`, `GrantMembership`)
 *   from simple blocks ("pay these suppliers", "swap USDC to A or B on these
 *   DEXes") using the same protocol sheets as `omniroles-conditions::presets`.
 * - Turns any rule change back into English sentences, so DAO members vote on
 *   what a proposal does, not on JSON.
 *
 * Browser-safe: depends on viem only.
 */
import { decodeFunctionData, encodeAbiParameters, erc20Abi, formatUnits, getAddress, keccak256, parseAbi, parseUnits, toBytes, toHex, type Hex } from "viem";

// ---------------------------------------------------------------------------
// Vault JSON types (contracts/vault/src/types.rs)
// ---------------------------------------------------------------------------

export type ConditionFlat = { parent: number; paramType: number; operator: number; compValue: Hex };

export type Permission = {
  chain_id: number;
  target: number[];
  selector: number[] | null;
  conditions: ConditionFlat[];
  allow_value: boolean;
};

export type RoleConfig = {
  enabled: boolean;
  permissions: Permission[];
  operation_delay_threshold: string | null;
  operation_delay_ns: number;
  co_sign_threshold: string | null;
  co_signer_role: string | null;
  velocity: { limit: string; window_ns: number } | null;
  gas_limit: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  max_total_fee: string;
};

export type MembershipKind = "Human" | "Agent";

export type RuleChange =
  | { SetRole: { role: string; config: RoleConfig } }
  | { RemoveRole: { role: string } }
  | {
      GrantMembership: {
        role: string;
        member: string;
        kind: MembershipKind;
        starts_at_ns: string;
        ends_at_ns: string | null;
        max_uses: number | null;
      };
    }
  | { RevokeMembership: { role: string; member: string } }
  | { SetAllowance: { key: number[]; balance: string; refill: string; max_refill: string; period_ns: number } }
  | { SetCouncil: { members: string[] } }
  | { SetVisaPublicKey: { visa_public_key: number[] } }
  | { SetStatusPublicKey: { status_public_key: number[] } }
  | { SetVersions: { policy_version: number; registry_version: number } };

// Encodings and operators (Zodiac Roles v3 numbering).
export const Encoding = { None: 0, Static: 1, Dynamic: 2, Tuple: 3, Array: 4, AbiEncoded: 5, EtherValue: 6 } as const;
export const Operator = {
  Pass: 0, And: 1, Or: 2, Empty: 4, Matches: 5, ArraySome: 6, ArrayEvery: 7,
  EqualToAvatar: 15, EqualTo: 16, GreaterThan: 17, LessThan: 18,
  SignedIntGreaterThan: 19, SignedIntLessThan: 20, Bitmask: 21,
  WithinAllowance: 28, CallWithinAllowance: 30,
} as const;

// ---------------------------------------------------------------------------
// Known contracts
// ---------------------------------------------------------------------------

export type Token = { address: Hex; symbol: string; decimals: number };
export type ProtocolId = "uniswap-v3" | "uniswap-v2";

export type ChainProfile = {
  chainId: number;
  name: string;
  tokens: Token[];
  protocols: Record<ProtocolId, { name: string; router: Hex }>;
};

export const BASE_SEPOLIA: ChainProfile = {
  chainId: 84532,
  name: "Base Sepolia",
  tokens: [
    { address: "0x418A2b47911dE05e21688F7490195F5324B49474", symbol: "TestUSDC", decimals: 6 },
    { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6 },
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
  ],
  protocols: {
    // developers.uniswap.org Base deployments (SwapRouter02); V2 router checked on-chain.
    "uniswap-v3": { name: "Uniswap V3", router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" },
    "uniswap-v2": { name: "Uniswap V2", router: "0x1689E7B1F10000AE47eBfE339a4f69dECd19F602" },
  },
};

export const SELECTORS = {
  transfer: "0xa9059cbb",
  approve: "0x095ea7b3",
  exactInputSingle: "0x04e45aaf",
  swapExactTokensForTokens: "0x38ed1739",
} as const;

// Parameter names of the functions the sheets scope, for descriptions.
const FUNCTIONS: Record<string, { name: string; params: string[]; tuple?: { index: number; fields: string[] } }> = {
  [SELECTORS.transfer]: { name: "transfer", params: ["recipient", "amount"] },
  [SELECTORS.approve]: { name: "approve", params: ["spender", "amount"] },
  [SELECTORS.exactInputSingle]: {
    name: "swap (exactInputSingle)",
    params: ["params"],
    tuple: {
      index: 0,
      fields: ["token sold", "token bought", "fee tier", "recipient", "amount sold", "minimum received", "price limit"],
    },
  },
  [SELECTORS.swapExactTokensForTokens]: {
    name: "swap (swapExactTokensForTokens)",
    params: ["amount sold", "minimum received", "route", "recipient", "deadline"],
  },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function bytes(hex: Hex): number[] {
  return Array.from(toBytes(hex));
}

export function hexOf(value: number[]): Hex {
  return toHex(Uint8Array.from(value));
}

const word = (value: bigint): Hex => encodeAbiParameters([{ type: "uint256" }], [value]);
const addressWord = (address: Hex): Hex => encodeAbiParameters([{ type: "address" }], [getAddress(address)]);
const node = (parent: number, paramType: number, operator: number, compValue: Hex = "0x"): ConditionFlat => ({
  parent, paramType, operator, compValue,
});

export function allowanceKey(role: string, label: string): number[] {
  return bytes(keccak256(toBytes(`mandateos:allowance:${role}:${label}`)));
}

function oneOf(parent: number, values: Hex[]): { field: ConditionFlat; alternatives: ConditionFlat[] } {
  if (values.length === 1) {
    return { field: node(parent, Encoding.Static, Operator.EqualTo, addressWord(values[0]!)), alternatives: [] };
  }
  return {
    field: node(parent, Encoding.None, Operator.Or),
    alternatives: values.map((value) => node(0, Encoding.Static, Operator.EqualTo, addressWord(value))),
  };
}

function withParent(nodes: ConditionFlat[], parent: number): ConditionFlat[] {
  return nodes.map((item) => ({ ...item, parent }));
}

function requireNonEmpty<T>(values: T[], what: string): void {
  if (values.length === 0) throw new Error(`at least one ${what} is required`);
}

// ---------------------------------------------------------------------------
// Protocol sheets (same trees as omniroles-conditions::presets)
// ---------------------------------------------------------------------------

export type Sheet = { target: Hex; selector: Hex; conditions: ConditionFlat[] };

export function erc20ApproveSheet(token: Hex, spenders: Hex[], maxAmount: bigint): Sheet {
  requireNonEmpty(spenders, "spender");
  const { field, alternatives } = oneOf(0, spenders);
  return {
    target: token,
    selector: SELECTORS.approve,
    conditions: [
      node(0, Encoding.AbiEncoded, Operator.Matches),
      field,
      node(0, Encoding.Static, Operator.LessThan, word(maxAmount + 1n)),
      ...withParent(alternatives, 1),
    ],
  };
}

export function erc20TransferSheet(token: Hex, recipients: Hex[], key: number[]): Sheet {
  requireNonEmpty(recipients, "recipient");
  const { field, alternatives } = oneOf(0, recipients);
  return {
    target: token,
    selector: SELECTORS.transfer,
    conditions: [
      node(0, Encoding.AbiEncoded, Operator.Matches),
      field,
      node(0, Encoding.Static, Operator.WithinAllowance, hexOf(key)),
      ...withParent(alternatives, 1),
    ],
  };
}

export function uniswapV3Sheet(router: Hex, tokenIn: Hex, tokensOut: Hex[], key: number[]): Sheet {
  requireNonEmpty(tokensOut, "output token");
  const { field, alternatives } = oneOf(1, tokensOut);
  return {
    target: router,
    selector: SELECTORS.exactInputSingle,
    conditions: [
      node(0, Encoding.AbiEncoded, Operator.Matches),
      node(0, Encoding.Tuple, Operator.Matches),
      node(1, Encoding.Static, Operator.EqualTo, addressWord(tokenIn)),
      field,
      node(1, Encoding.Static, Operator.Pass),
      node(1, Encoding.Static, Operator.EqualToAvatar),
      node(1, Encoding.Static, Operator.WithinAllowance, hexOf(key)),
      node(1, Encoding.Static, Operator.GreaterThan, word(0n)),
      node(1, Encoding.Static, Operator.Pass),
      ...withParent(alternatives, 3),
    ],
  };
}

/** keccak256 of `length || elements` of an ABI-encoded address[] (EqualTo on arrays). */
export function routeHash(path: Hex[]): Hex {
  const encoded = encodeAbiParameters([{ type: "address[]" }], [path.map((hop) => getAddress(hop))]);
  return keccak256(`0x${encoded.slice(66)}`);
}

export function uniswapV2Sheet(router: Hex, paths: Hex[][], key: number[]): Sheet {
  requireNonEmpty(paths, "route");
  const conditions = [
    node(0, Encoding.AbiEncoded, Operator.Matches),
    node(0, Encoding.Static, Operator.WithinAllowance, hexOf(key)),
    node(0, Encoding.Static, Operator.GreaterThan, word(0n)),
    paths.length === 1
      ? node(0, Encoding.Array, Operator.EqualTo, routeHash(paths[0]!))
      : node(0, Encoding.None, Operator.Or),
    node(0, Encoding.Static, Operator.EqualToAvatar),
    node(0, Encoding.Static, Operator.Pass),
  ];
  if (paths.length === 1) {
    conditions.push(node(3, Encoding.Static, Operator.Pass));
  } else {
    const first = conditions.length;
    for (const path of paths) conditions.push(node(3, Encoding.Array, Operator.EqualTo, routeHash(path)));
    paths.forEach((_, offset) => conditions.push(node(first + offset, Encoding.Static, Operator.Pass)));
  }
  return { target: router, selector: SELECTORS.swapExactTokensForTokens, conditions };
}

// ---------------------------------------------------------------------------
// Role blocks -> rule changes
// ---------------------------------------------------------------------------

export type Budget = { amount: string; periodDays: number };
export type Recipient = { address: Hex; label: string };

export type RoleBlock =
  | { kind: "payments"; token: Hex; recipients: Recipient[]; budget: Budget }
  | {
      kind: "swap";
      tokenIn: Hex;
      tokensOut: Hex[];
      protocols: ProtocolId[];
      budget: Budget;
      /** Largest single approval to a router, in tokenIn units. */
      maxApproval: string;
    };

export type RoleMember = { accountId: string; kind: MembershipKind; maxUses?: number | null; endsAt?: Date | null };

export type RoleDraft = {
  name: string;
  blocks: RoleBlock[];
  members: RoleMember[];
  gas?: Partial<Pick<RoleConfig, "gas_limit" | "max_fee_per_gas" | "max_priority_fee_per_gas" | "max_total_fee">>;
};

const DEFAULT_GAS = {
  gas_limit: "300000",
  max_fee_per_gas: "100000000000",
  max_priority_fee_per_gas: "10000000000",
  max_total_fee: "30000000000000000",
};

const NS_PER_DAY = 86_400_000_000_000;

export function tokenOf(profile: ChainProfile, address: Hex): Token {
  const token = profile.tokens.find((item) => item.address.toLowerCase() === address.toLowerCase());
  if (!token) throw new Error(`unknown token ${address} on ${profile.name}`);
  return token;
}

export function validRoleName(name: string): boolean {
  return /^[a-z][a-z0-9-]{1,31}$/.test(name);
}

/** Rule changes that create (or replace) a role, its budgets and its members. */
export function compileRole(draft: RoleDraft, profile: ChainProfile): RuleChange[] {
  if (!validRoleName(draft.name)) throw new Error("role name: 2-32 lowercase letters, digits or dashes, starting with a letter");
  requireNonEmpty(draft.blocks, "block");
  const changes: RuleChange[] = [];
  const permissions: Permission[] = [];
  const toPermission = (sheet: Sheet): Permission => ({
    chain_id: profile.chainId,
    target: bytes(getAddress(sheet.target)),
    selector: bytes(sheet.selector),
    conditions: sheet.conditions,
    allow_value: false,
  });
  draft.blocks.forEach((block, index) => {
    const label = `${block.kind}-${index + 1}`;
    const key = allowanceKey(draft.name, label);
    const token = tokenOf(profile, block.kind === "payments" ? block.token : block.tokenIn);
    const amount = parseUnits(block.budget.amount, token.decimals);
    if (amount <= 0n) throw new Error("budget must be positive");
    if (!(block.budget.periodDays > 0)) throw new Error("budget period must be positive");
    changes.push({
      SetAllowance: {
        key,
        balance: amount.toString(),
        refill: amount.toString(),
        max_refill: amount.toString(),
        period_ns: Math.round(block.budget.periodDays * NS_PER_DAY),
      },
    });
    if (block.kind === "payments") {
      permissions.push(toPermission(erc20TransferSheet(token.address, block.recipients.map((item) => item.address), key)));
    } else {
      requireNonEmpty(block.protocols, "protocol");
      tokensOutCheck(block, profile);
      const routers = block.protocols.map((id) => profile.protocols[id].router);
      permissions.push(toPermission(erc20ApproveSheet(token.address, routers, parseUnits(block.maxApproval, token.decimals))));
      for (const id of block.protocols) {
        const router = profile.protocols[id].router;
        permissions.push(toPermission(
          id === "uniswap-v3"
            ? uniswapV3Sheet(router, token.address, block.tokensOut, key)
            : uniswapV2Sheet(router, block.tokensOut.map((out) => [token.address, out]), key),
        ));
      }
    }
  });
  changes.push({
    SetRole: {
      role: draft.name,
      config: {
        enabled: true,
        permissions,
        // Humans set the constraints; operations are allowed or refused by policy alone.
        operation_delay_threshold: null,
        operation_delay_ns: 0,
        co_sign_threshold: null,
        co_signer_role: null,
        velocity: null,
        ...DEFAULT_GAS,
        ...draft.gas,
      },
    },
  });
  for (const member of draft.members) {
    changes.push({
      GrantMembership: {
        role: draft.name,
        member: member.accountId,
        kind: member.kind,
        starts_at_ns: "0",
        ends_at_ns: member.endsAt ? (BigInt(member.endsAt.getTime()) * 1_000_000n).toString() : null,
        max_uses: member.maxUses ?? null,
      },
    });
  }
  return changes;
}

function tokensOutCheck(block: Extract<RoleBlock, { kind: "swap" }>, profile: ChainProfile): void {
  requireNonEmpty(block.tokensOut, "output token");
  for (const out of block.tokensOut) {
    tokenOf(profile, out);
    if (out.toLowerCase() === block.tokenIn.toLowerCase()) throw new Error("a swap must change token");
  }
}

// ---------------------------------------------------------------------------
// DAO proposal (Sputnik FunctionCall to the vault)
// ---------------------------------------------------------------------------

export const PROPOSAL_MARKER = "[mandateos]";
const RULE_GAS = "20000000000000"; // 20 Tgas per queued rule change
const WALLET_GAS = "60000000000000"; // MPC derivation + callback

export type VaultCall = { method: "queue_rule_change"; change: RuleChange } | { method: "request_wallet"; chainId: number } | { method: "pause" | "unpause" };

export function proposalArgs(vaultAccountId: string, title: string, calls: VaultCall[]) {
  requireNonEmpty(calls, "vault call");
  const actions = calls.map((call) => {
    const args = call.method === "queue_rule_change"
      ? { change: call.change }
      : call.method === "request_wallet"
        ? { chain_id: call.chainId }
        : {};
    return {
      method_name: call.method,
      args: btoa(JSON.stringify(args)),
      deposit: "0",
      gas: call.method === "request_wallet" ? WALLET_GAS : RULE_GAS,
    };
  });
  return {
    proposal: {
      description: `${PROPOSAL_MARKER} ${title}`,
      kind: { FunctionCall: { receiver_id: vaultAccountId, actions } },
    },
  };
}

// ---------------------------------------------------------------------------
// DAO members (Sputnik policy)
// ---------------------------------------------------------------------------

export const COUNCIL_ROLE = "council";
export const COUNCIL_PERMISSIONS = ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"];

export type DaoPolicy = {
  roles: Array<{ name: string; kind: unknown; permissions: string[]; vote_policy: Record<string, unknown> }>;
  default_vote_policy: { weight_kind: string; quorum: string; threshold: unknown };
  proposal_bond: string;
  proposal_period: string;
  bounty_bond: string;
  bounty_forgiveness_period: string;
};

/** Two thirds of the members, rounded up. */
export function councilThreshold(members: number): number {
  return Math.ceil((2 * members) / 3);
}

/** The only policy MandateOS creates: one council group, two-thirds threshold. */
export function councilPolicy(members: string[], settings: { proposalBond: string; proposalPeriodNs: string }): DaoPolicy {
  if (members.length < 3) throw new Error("at least three members are needed");
  if (new Set(members).size !== members.length) throw new Error("a member is listed twice");
  return {
    roles: [{ name: COUNCIL_ROLE, kind: { Group: members }, permissions: [...COUNCIL_PERMISSIONS], vote_policy: {} }],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: String(councilThreshold(members.length)) },
    proposal_bond: settings.proposalBond,
    proposal_period: settings.proposalPeriodNs,
    bounty_bond: settings.proposalBond,
    bounty_forgiveness_period: settings.proposalPeriodNs,
  };
}

export function membersProposalArgs(policy: DaoPolicy, title: string) {
  return { proposal: { description: `${PROPOSAL_MARKER} ${title}`, kind: { ChangePolicy: { policy } } } };
}

/**
 * Describe a ChangePolicy proposal. Anything that is not the standard council
 * policy (other roles, other permissions, another vote rule) is spelled out
 * as a warning: it could hand the treasury to someone else.
 */
export function describePolicyChange(kind: unknown): { title: string; details: string[]; members: string[]; standard: boolean } | null {
  const policy = (kind as { ChangePolicy?: { policy?: DaoPolicy } })?.ChangePolicy?.policy;
  if (!policy || !Array.isArray(policy.roles)) return null;
  const members = policy.roles.flatMap((role) => ((role.kind as { Group?: string[] })?.Group ?? []));
  const warnings: string[] = [];
  if (policy.roles.length !== 1 || policy.roles[0]?.name !== COUNCIL_ROLE) warnings.push(`⚠ unusual roles: ${policy.roles.map((role) => role.name).join(", ")}`);
  for (const role of policy.roles) {
    if ((role.kind as { Group?: unknown })?.Group === undefined) warnings.push(`⚠ role "${role.name}" is open to ${JSON.stringify(role.kind)}`);
    const extra = role.permissions.filter((permission) => !COUNCIL_PERMISSIONS.includes(permission));
    if (extra.length) warnings.push(`⚠ role "${role.name}" gets extra permissions: ${extra.join(", ")}`);
    if (Object.keys(role.vote_policy ?? {}).length) warnings.push(`⚠ role "${role.name}" has its own vote rule`);
  }
  const vote = policy.default_vote_policy;
  const threshold = String(vote?.threshold ?? "");
  if (vote?.weight_kind !== "RoleWeight" || threshold !== String(councilThreshold(members.length))) {
    warnings.push(`⚠ vote rule ${JSON.stringify(vote)} instead of ${councilThreshold(members.length)} of ${members.length}`);
  }
  return {
    title: `Members become: ${members.join(", ")}`,
    details: [
      `a decision will need ${threshold} of ${members.length} approvals`,
      "applies as soon as it is approved",
      ...warnings,
    ],
    members,
    standard: warnings.length === 0,
  };
}

/** Decode the vault calls of a Sputnik proposal kind (null if it is not a vault call). */
export function decodeVaultCalls(kind: unknown, vaultAccountId: string): VaultCall[] | null {
  const functionCall = (kind as { FunctionCall?: { receiver_id?: string; actions?: Array<{ method_name: string; args: string }> } })?.FunctionCall;
  if (!functionCall || functionCall.receiver_id !== vaultAccountId || !Array.isArray(functionCall.actions)) return null;
  return functionCall.actions.map((action) => {
    const args = JSON.parse(atob(action.args)) as Record<string, unknown>;
    if (action.method_name === "queue_rule_change") return { method: "queue_rule_change", change: args.change as RuleChange };
    if (action.method_name === "request_wallet") return { method: "request_wallet", chainId: Number(args.chain_id) };
    if (action.method_name === "pause" || action.method_name === "unpause") return { method: action.method_name };
    throw new Error(`unknown vault method ${action.method_name}`);
  });
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

export type DescribeContext = {
  profile: ChainProfile;
  /** Labels for addresses (suppliers, routers, wallet...). */
  labels?: Record<string, string>;
  /** Allowance key (hex, lowercase) -> what it measures; see `budgetsOf`. */
  budgets?: Record<string, BudgetInfo>;
  /**
   * Print the full address next to every label that does not come from the
   * profile. Labels are names a server stored; the address is what the vault
   * enforces, so a voter must see it.
   */
  fullAddresses?: boolean;
};

/** Name a V2 route by matching its hash against two-hop routes between known tokens. */
function routeName(hash: Hex, context: DescribeContext): string | null {
  const tokens = context.profile.tokens;
  for (const from of tokens) {
    for (const to of tokens) {
      if (from === to) continue;
      if (routeHash([from.address, to.address]).toLowerCase() === hash.toLowerCase()) return `${from.symbol} → ${to.symbol}`;
    }
  }
  return null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function budgetName(key: Hex, context: DescribeContext): string {
  return context.budgets?.[key.toLowerCase()]?.label ?? short(key);
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function labelAddress(address: Hex, context: DescribeContext): string {
  const key = address.toLowerCase();
  const label = Object.entries(context.labels ?? {}).find(([candidate]) => candidate.toLowerCase() === key)?.[1];
  const full = getAddress(address);
  if (label) return context.fullAddresses ? `${label} (${full})` : label;
  const token = context.profile.tokens.find((item) => item.address.toLowerCase() === key);
  if (token) return token.symbol;
  const protocol = Object.values(context.profile.protocols).find((item) => item.router.toLowerCase() === key);
  if (protocol) return `${protocol.name} router`;
  return `${context.fullAddresses ? full : short(full)} (not a registered supplier)`;
}

function wordToAddress(value: Hex): Hex {
  return getAddress(`0x${value.slice(-40)}`);
}

function amountText(value: bigint, token: Token | undefined): string {
  return token ? `${Number(formatUnits(value, token.decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${token.symbol}` : value.toString();
}

function periodText(periodNs: number): string {
  const days = periodNs / NS_PER_DAY;
  if (days === 1) return "every day";
  if (Number.isInteger(days)) return `every ${days} days`;
  const hours = periodNs / 3_600_000_000_000;
  return Number.isInteger(hours) ? `every ${hours} hours` : `every ${periodNs} ns`;
}

export type BudgetInfo = { token?: Token | undefined; label: string };

/**
 * What each allowance key measures, read from the roles that charge it:
 * transfers count in the token transferred, swaps in the token sold (for V2
 * routes, the token the role approves to that router).
 */
export function budgetsOf(changes: RuleChange[], profile: ChainProfile): Record<string, BudgetInfo> {
  const result: Record<string, BudgetInfo> = {};
  const findToken = (address: Hex) => profile.tokens.find((item) => item.address.toLowerCase() === address.toLowerCase());
  for (const change of changes) {
    if (!("SetRole" in change)) continue;
    const { role, config } = change.SetRole;
    const approvals = config.permissions.filter((permission) => permission.selector && hexOf(permission.selector) === SELECTORS.approve);
    const approvedTokenFor = (router: Hex): Token | undefined => {
      for (const approval of approvals) {
        const spenders = approval.conditions
          .filter((item) => item.operator === Operator.EqualTo && item.paramType === Encoding.Static)
          .map((item) => wordToAddress(item.compValue).toLowerCase());
        if (spenders.includes(router.toLowerCase())) return findToken(hexOf(approval.target));
      }
      return undefined;
    };
    for (const permission of config.permissions) {
      const target = hexOf(permission.target);
      const selector = permission.selector ? hexOf(permission.selector) : null;
      for (const condition of permission.conditions) {
        if (condition.operator !== Operator.WithinAllowance) continue;
        let token: Token | undefined;
        let kind = "budget";
        if (selector === SELECTORS.transfer) {
          token = findToken(target);
          kind = "payments";
        } else if (selector === SELECTORS.exactInputSingle) {
          const tokenIn = permission.conditions[2];
          if (tokenIn?.operator === Operator.EqualTo) token = findToken(wordToAddress(tokenIn.compValue));
          kind = "swaps";
        } else if (selector === SELECTORS.swapExactTokensForTokens) {
          token = approvedTokenFor(target);
          kind = "swaps";
        }
        const key = condition.compValue.toLowerCase();
        const existing = result[key];
        result[key] = { token: existing?.token ?? token, label: `${role} ${kind}` };
      }
    }
  }
  return result;
}

/** One line per condition of a permission. */
export function describePermission(permission: Permission, context: DescribeContext): { title: string; rules: string[] } {
  const target = hexOf(permission.target);
  const selector = permission.selector ? hexOf(permission.selector) : null;
  const fn = selector ? FUNCTIONS[selector] : undefined;
  const contract = labelAddress(target, context);
  const title = selector
    ? `${fn ? fn.name : `function ${selector}`} on ${contract}`
    : `any function on ${contract}`;
  const rules: string[] = [];
  if (permission.allow_value) rules.push("may send ETH with the call");
  const conditions = permission.conditions;
  if (conditions.length === 0) {
    rules.push("no parameter restriction");
    return { title, rules };
  }
  const targetToken = context.profile.tokens.find((item) => item.address.toLowerCase() === target.toLowerCase());
  const tokenIn = selector === SELECTORS.exactInputSingle && conditions[2]?.operator === Operator.EqualTo
    ? context.profile.tokens.find((item) => item.address.toLowerCase() === wordToAddress(conditions[2]!.compValue).toLowerCase())
    : undefined;
  const children = (index: number) => conditions.map((item, position) => ({ item, position })).filter(({ item, position }) => position > 0 && item.parent === index);
  const nameOf = (parentIndex: number, fieldIndex: number): string => {
    if (fn?.tuple && parentIndex !== 0) return fn.tuple.fields[fieldIndex] ?? `field ${fieldIndex + 1}`;
    return fn?.params[fieldIndex] ?? `parameter ${fieldIndex + 1}`;
  };
  const amountToken = (name: string): Token | undefined => {
    if (name.includes("amount") || name.includes("minimum")) return tokenIn ?? (selector === SELECTORS.transfer || selector === SELECTORS.approve ? targetToken : undefined);
    return undefined;
  };
  const describeNode = (index: number, name: string): void => {
    const item = conditions[index]!;
    switch (item.operator) {
      case Operator.Pass:
        return;
      case Operator.Matches:
        children(index).forEach(({ position }, fieldIndex) => describeNode(position, nameOf(index, fieldIndex)));
        return;
      case Operator.EqualToAvatar:
        rules.push(`${name} must be the company wallet`);
        return;
      case Operator.EqualTo:
        if (item.paramType === Encoding.Array) {
          rules.push(`${name} must be ${routeName(item.compValue, context) ?? "an approved route"}`);
        } else if (item.paramType === Encoding.Static && /^0x0{24}/i.test(item.compValue)) {
          rules.push(`${name} must be ${labelAddress(wordToAddress(item.compValue), context)}`);
        } else {
          rules.push(`${name} must equal ${item.compValue}`);
        }
        return;
      case Operator.Or: {
        const options = children(index).map(({ item: option }) =>
          option.paramType === Encoding.Static && option.operator === Operator.EqualTo
            ? labelAddress(wordToAddress(option.compValue), context)
            : option.paramType === Encoding.Array ? routeName(option.compValue, context) ?? "an approved route" : "an allowed value");
        rules.push(`${name} must be one of: ${[...new Set(options)].join(", ")}`);
        return;
      }
      case Operator.GreaterThan: {
        const bound = BigInt(item.compValue);
        rules.push(bound === 0n ? `${name} must be set (not zero)` : `${name} must be more than ${amountText(bound, amountToken(name))}`);
        return;
      }
      case Operator.LessThan:
        rules.push(`${name} at most ${amountText(BigInt(item.compValue) - 1n, amountToken(name))}`);
        return;
      case Operator.WithinAllowance: {
        rules.push(`${name} is counted against the ${budgetName(item.compValue, context)} budget`);
        return;
      }
      case Operator.CallWithinAllowance:
        rules.push(`each call is counted against the ${budgetName(item.compValue, context)} budget`);
        return;
      default:
        rules.push(`${name}: condition ${item.operator}`);
    }
  };
  describeNode(0, "call");
  return { title, rules };
}

/** English sentences for a rule change. */
export function describeChange(change: RuleChange, context: DescribeContext): { title: string; details: string[] } {
  if ("SetAllowance" in change) {
    const { key, balance, period_ns } = change.SetAllowance;
    const info = context.budgets?.[hexOf(key).toLowerCase()];
    const amount = amountText(BigInt(balance), info?.token);
    return {
      title: `${capitalize(budgetName(hexOf(key), context))} budget: ${amount} ${period_ns > 0 ? periodText(period_ns) : "(one-time)"}`,
      details: [period_ns > 0 ? `Refilled up to ${amount} ${periodText(period_ns)}.` : "Not refilled."],
    };
  }
  if ("SetRole" in change) {
    const { role, config } = change.SetRole;
    const details = config.permissions.flatMap((permission) => {
      const described = describePermission(permission, context);
      return [described.title, ...described.rules.map((rule) => `  · ${rule}`)];
    });
    if (config.operation_delay_threshold) details.push(`Operations above ${config.operation_delay_threshold} wait ${config.operation_delay_ns / 1e9}s (council can veto).`);
    if (config.co_sign_threshold) details.push(`Operations above ${config.co_sign_threshold} need a co-signature from role ${config.co_signer_role ?? "?"}.`);
    if (!config.enabled) details.push("Role disabled.");
    return { title: `${config.enabled ? "Set" : "Disable"} role "${role}" (${config.permissions.length} permission${config.permissions.length > 1 ? "s" : ""})`, details };
  }
  if ("GrantMembership" in change) {
    const { role, member, kind, ends_at_ns, max_uses } = change.GrantMembership;
    const limits = [
      ends_at_ns ? `until ${new Date(Number(BigInt(ends_at_ns) / 1_000_000n)).toISOString().slice(0, 16).replace("T", " ")} UTC` : "no end date",
      max_uses ? `at most ${max_uses} operations` : "no usage limit",
    ];
    return { title: `Give role "${role}" to ${kind === "Agent" ? "AI agent" : "human"} ${member}`, details: [limits.join(", ")] };
  }
  if ("RevokeMembership" in change) return { title: `Remove ${change.RevokeMembership.member} from role "${change.RevokeMembership.role}"`, details: [] };
  if ("RemoveRole" in change) return { title: `Delete role "${change.RemoveRole.role}"`, details: [] };
  if ("SetCouncil" in change) return { title: "Replace the security council", details: [change.SetCouncil.members.join(", ")] };
  if ("SetVisaPublicKey" in change) return { title: "Rotate the Guard visa key", details: [] };
  if ("SetStatusPublicKey" in change) return { title: "Rotate the Guard status key", details: [] };
  return { title: `Set policy version ${change.SetVersions.policy_version}, registry version ${change.SetVersions.registry_version}`, details: [] };
}

export function describeVaultCall(call: VaultCall, context: DescribeContext): { title: string; details: string[] } {
  if (call.method === "request_wallet") return { title: `Create the company wallet on ${call.chainId === context.profile.chainId ? context.profile.name : `chain ${call.chainId}`}`, details: [] };
  if (call.method === "pause") return { title: "Pause all operations", details: [] };
  if (call.method === "unpause") return { title: "Resume operations", details: [] };
  if (call.method === "queue_rule_change") return describeChange(call.change, context);
  return { title: "Unknown vault call", details: [] };
}

const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

/** One sentence for a call an agent asked for (activity feed). */
export function describeCall(target: Hex, calldata: Hex, value: bigint, context: DescribeContext): string {
  const token = context.profile.tokens.find((item) => item.address.toLowerCase() === target.toLowerCase());
  const label = (address: Hex) => labelAddress(address, context);
  try {
    if (calldata === "0x") return `send ${formatUnits(value, 18)} ETH to ${label(target)}`;
    const selector = calldata.slice(0, 10);
    if (selector === SELECTORS.transfer || selector === SELECTORS.approve) {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: calldata });
      const [who, amount] = decoded.args as readonly [Hex, bigint];
      const amountLabel = amount >= 2n ** 255n ? "an unlimited amount of" : amountText(amount, token);
      return decoded.functionName === "transfer"
        ? `transfer ${amountText(amount, token)} to ${label(who)}`
        : `approve ${label(who)} to spend ${amountLabel}${amount >= 2n ** 255n && token ? ` ${token.symbol}` : ""}`;
    }
    if (selector === SELECTORS.exactInputSingle || selector === SELECTORS.swapExactTokensForTokens) {
      const decoded = decodeFunctionData({ abi: ROUTER_ABI, data: calldata });
      if (decoded.functionName === "exactInputSingle") {
        const params = decoded.args[0];
        const tokenIn = context.profile.tokens.find((item) => item.address.toLowerCase() === params.tokenIn.toLowerCase());
        return `swap ${amountText(params.amountIn, tokenIn)} for ${label(params.tokenOut)} on ${label(target)}, sent to ${label(params.recipient)}`;
      }
      const [amountIn, , path, to] = decoded.args;
      const tokenIn = context.profile.tokens.find((item) => item.address.toLowerCase() === path[0]?.toLowerCase());
      return `swap ${amountText(amountIn, tokenIn)} along ${path.map((hop) => label(hop)).join(" → ")} on ${label(target)}, sent to ${label(to)}`;
    }
  } catch {
    // fall through
  }
  return `call ${calldata.slice(0, 10)} on ${label(target)}`;
}
