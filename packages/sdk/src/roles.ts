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
import { base58Encode, SOLANA_DEVNET, solanaAddress, solanaAsset, solanaTokenOf } from "./solana.js";
import { concatHex, decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, getAddress, keccak256, parseAbi, parseUnits, sha256, toBytes, toHex, type Hex } from "viem";

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
  guard_required?: boolean;
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
  | { AddListAddresses: { list: string; entries: Array<{address: number[]; label: string}> } }
  | { AddListAddress: { list: string; address: number[]; label: string } }
  | { RemoveListAddress: { list: string; address: number[] } }
  | { SetSettlementConfig: { config: { cancel_after_ns: string; unconfirmed_after_ns: string; foreign_tx_domain_id: number; mainnet: boolean } } }
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
  | { SetVersions: { policy_version: number; registry_version: number } }
  /** Move the vault to a version published on Nomos (base58 sha256 of the WASM). */
  | { Upgrade: { code_hash: string } }
  /** What the role may send on Solana; replaces the role's list. */
  | { SetSolanaPermissions: { role: string; permissions: SolanaPermission[] } }
  /** NEP-141 tokens the role may send from the vault account; replaces the role's list. */
  | { SetNearPermissions: { role: string; permissions: NearPermission[] } }
  /** Register the vault on a NEP-141 token (NEP-145), so it can hold it. */
  | { NearStorageDeposit: { token: string } }
  /** Fetch future versions from another Nomos; upgrades are still checked by hash. */
  | { SetCodeSource: { account_id: string } }
  /** Euro payouts to voted IBANs: where the bank signer runs and how the transfer settles. */
  | { SetBankConfig: { config: BankConfig | null } }
  | { AddBankBeneficiary: { beneficiary: BankBeneficiary } }
  | { RemoveBankBeneficiary: { iban: string } }
  | { SetBankPermission: { role: string; permission: BankPermission | null } }
  /** The bank signer enclave's X25519 key (hex), which beneficiaries are sealed to. */
  | { SetBankBoxKey: { key: string | null } }
  /** A beneficiary without its IBAN: commitment and envelopes (bank-private.ts). `label` is public. */
  | { AddSealedBankBeneficiary: { label: string; commitment: string; sealed_for_signer: string; sealed_for_members: string } }
  | { RemoveSealedBankBeneficiary: { id: number } }
  /** Payroll, rent: pay a voted beneficiary `amount` every `period_ns` from `first_at_ns`; run by anyone once due. */
  | { AddStandingOrder: { beneficiary_id: number; amount: string; first_at_ns: string; period_ns: string; count: number | null; label: string } }
  | { RemoveStandingOrder: { id: number } };

export type BankConfig = {
  outlayer_id: string;
  signer_url: string;
  signer_hash: string;
  secrets_owner: string;
  secrets_profile: string;
  customer_id: string;
  network: string;
  crypto: string;
  chain_id: number;
  token: number[];
  decimals: number;
  gas_limit: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
};
/** The first version's beneficiary in clear: the vault refuses it now (an IBAN would stay public). */
export type BankBeneficiary = { iban: string; name: string; holder_type: "Business" | "Individual" };
export type SealedBeneficiary = { id: number; label: string; commitment: string; sealed_for_signer: string; sealed_for_members: string };
/** Budget charged in the euro token's base units; the ceiling applies to one payout. */
export type BankPermission = { allowance: number[]; max_per_payout: string };
/** The budget a role gets for euro payouts when it has no EURC budget yet. */
export const euroPayoutBudgetKey = (role: string): number[] => allowanceKey(role, "euro-payouts");
export type BankPayoutState = "Requested" | "Transferring" | "Failed";
export type BankPayout = {
  op_id: number[];
  member: string;
  role: string;
  beneficiary_id: number;
  beneficiary_label: string;
  commitment: string;
  amount: string;
  reference: string;
  state: BankPayoutState;
  created_at_ns: string;
  expires_at_ns: string;
  rule_id: string | null;
  deposit_address: number[] | null;
  fiat_amount: string | null;
  transfer_op_id: number[] | null;
  error: string | null;
};
/** IBANs compare without spaces, in upper case. */
export function canonicalIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}
/** ISO 7064 mod 97-10, as the vault checks it before a vote. */
export function validIban(iban: string): boolean {
  const compact = canonicalIban(iban);
  if (compact.length < 15 || compact.length > 34 || !/^[A-Z0-9]+$/.test(compact)) return false;
  const rotated = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const c of rotated) {
    const value = c >= "A" ? c.charCodeAt(0) - 55 : Number(c);
    for (const digit of String(value)) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}
export function formatIban(iban: string): string {
  return canonicalIban(iban).replace(/(.{4})/g, "$1 ").trim();
}

export type SolanaPermission = { asset: "Sol" | { Spl: { mint: number[] } }; recipients: number[][]; allowance: number[] };
export type NearPermission = { token: string; receivers: string[]; allowance: number[]; min_per_transfer: string; max_per_transfer: string };

export type NearToken = { accountId: string; symbol: string; decimals: number };
/** NEP-141 tokens on NEAR testnet a role may send. USDC is Circle's (faucet.circle.com). */
export const NEAR_TESTNET_TOKENS: NearToken[] = [
  { accountId: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af", symbol: "USDC", decimals: 6 },
  { accountId: "test-ft-v4.mandateos-root-20261021.testnet", symbol: "TestUSDC", decimals: 6 },
];
/**
 * Default floor per transfer, as a share of the budget: each transfer stores a
 * record the vault pays for, so by default a role makes at most 100 per period.
 */
export const NEAR_DEFAULT_TRANSFERS_PER_PERIOD = 100n;

export function nearTokenOf(token: string, tokens: NearToken[] = NEAR_TESTNET_TOKENS): NearToken {
  const found = tokens.find((item) => item.accountId === token || item.symbol === token);
  if (!found) throw new Error(`unknown NEAR token ${token}`);
  return found;
}

/**
 * The agent's spending card on NEAR: a plain account next to the agent's,
 * `<slug>-card.<parent>` for `<slug>-agent.<parent>`. It holds small token
 * amounts the vault refills by role, so the agent can pay on its own.
 */
export function cardAccountIdOf(agentAccountId: string): string {
  const match = agentAccountId.match(/^(.+)-agent\.(.+)$/);
  if (!match) throw new Error("not an agent account created by Euthyna");
  return `${match[1]}-card.${match[2]}`;
}

/** NEAR account ids: named (`a.b.testnet`) or implicit (64 hex). */
export function validNearAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}

// Encodings and operators of the OmniRoles condition format.
export const Encoding = { None: 0, Static: 1, Dynamic: 2, Tuple: 3, Array: 4, AbiEncoded: 5, EtherValue: 6 } as const;
export const Operator = {
  InAddressList: 40, Pass: 0, And: 1, Or: 2, Empty: 4, Matches: 5, ArraySome: 6, ArrayEvery: 7,
  EqualToAvatar: 15, EqualTo: 16, GreaterThan: 17, LessThan: 18,
  SignedIntGreaterThan: 19, SignedIntLessThan: 20, Bitmask: 21,
  WithinAllowance: 28, CallWithinAllowance: 30,
} as const;

// ---------------------------------------------------------------------------
// Known contracts
// ---------------------------------------------------------------------------

export type Token = { address: Hex; symbol: string; decimals: number };
export type ProtocolId = "uniswap-v3" | "uniswap-v2";
export type LendingId = "aave-v3";

export type ChainProfile = {
  chainId: number;
  name: string;
  tokens: Token[];
  protocols: Record<ProtocolId, { name: string; router: Hex }>;
  /** Lending pools a role may deposit into; deposits are always credited to the wallet. */
  lending?: Partial<Record<LendingId, { name: string; pool: Hex; assets: Hex[] }>>;
  /** NEAR Omni Bridge on this chain: sends ETH to a NEAR account. */
  omniBridge?: Hex;
  /** Wrapped ETH (WETH9) on this chain. */
  weth?: Hex;
};

/** ETH itself, for budgets on the value a call sends. */
export const NATIVE_ETH: Token = { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 };

export const BASE_SEPOLIA: ChainProfile = {
  chainId: 84532,
  name: "Base Sepolia",
  // First token = the default in the console. USDC is Circle's testnet USDC (faucet.circle.com);
  // TestUSDC is Euthyna's own test token, kept for companies that already use it.
  tokens: [
    { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6 },
    { address: "0x418A2b47911dE05e21688F7490195F5324B49474", symbol: "TestUSDC", decimals: 6 },
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
    // Aave's own test USDC on Base Sepolia (not Circle's): the asset its USDC reserve uses.
    { address: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", symbol: "USDC (Aave test)", decimals: 6 },
    // Noah's sandbox euro (symbol EURC_TEST on chain, 6 decimals): what the company's EUR IBAN settles into.
    { address: "0x623ef90571256F905B2Fde947dC33098BdD8F4d8", symbol: "EURC", decimals: 6 },
  ],
  lending: {
    // Pool read on chain: getReservesList() lists WETH and the test USDC above, both active.
    "aave-v3": {
      name: "Aave V3",
      pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
      assets: ["0x4200000000000000000000000000000000000006", "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f"],
    },
  },
  protocols: {
    // developers.uniswap.org Base deployments (SwapRouter02); V2 router checked on-chain.
    "uniswap-v3": { name: "Uniswap V3", router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" },
    "uniswap-v2": { name: "Uniswap V2", router: "0x1689E7B1F10000AE47eBfE339a4f69dECd19F602" },
  },
  // github.com/Near-One/omni-bridge README, testnet deployment on Base Sepolia.
  omniBridge: "0xa56b860017152cD296ad723E8409Abd6e5D86d4d",
  // OP Stack predeploy.
  weth: "0x4200000000000000000000000000000000000006",
};

export const SELECTORS = {
  transfer: "0xa9059cbb",
  approve: "0x095ea7b3",
  exactInputSingle: "0x04e45aaf",
  swapExactTokensForTokens: "0x38ed1739",
  /** Aave V3 Pool supply(address,uint256,address,uint16) */
  aaveSupply: "0x617ba037",
  /** Aave V3 Pool withdraw(address,uint256,address) */
  aaveWithdraw: "0x69328dec",
  /** WETH9 deposit() (wrap, sends ETH) and withdraw(uint256) (unwrap). */
  wethDeposit: "0xd0e30db0",
  wethWithdraw: "0x2e1a7d4d",
  /** initTransfer(address,uint128,uint128,uint128,string,string) on the Omni Bridge. */
  initTransfer: "0xdeb915b8",
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
  [SELECTORS.aaveSupply]: { name: "deposit (supply)", params: ["asset", "amount", "credited to", "referral code"] },
  [SELECTORS.aaveWithdraw]: { name: "withdraw", params: ["asset", "amount", "recipient"] },
  [SELECTORS.wethDeposit]: { name: "wrap ETH (deposit)", params: [] },
  [SELECTORS.wethWithdraw]: { name: "unwrap to ETH (withdraw)", params: ["amount"] },
  [SELECTORS.initTransfer]: {
    name: "bridge to NEAR (initTransfer)",
    params: ["token", "amount", "fee in token", "bridge fee", "NEAR recipient", "message", "ETH sent"],
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

export function aaveSupplySheet(pool: Hex, assets: Hex[], key: number[]): Sheet {
  requireNonEmpty(assets, "asset");
  const { field, alternatives } = oneOf(0, assets);
  return {
    target: pool,
    selector: SELECTORS.aaveSupply,
    conditions: [
      node(0, Encoding.AbiEncoded, Operator.Matches),
      field,
      node(0, Encoding.Static, Operator.WithinAllowance, hexOf(key)),
      node(0, Encoding.Static, Operator.EqualToAvatar),
      node(0, Encoding.Static, Operator.Pass),
      ...withParent(alternatives, 1),
    ],
  };
}

/** Withdrawals only return the company's deposit to the company wallet: no budget. */
/** weth.deposit(): the ETH sent is charged to the budget. */
export function wethWrapSheet(weth: Hex, key: number[]): Sheet {
  return {
    target: weth,
    selector: SELECTORS.wethDeposit,
    conditions: [node(0, Encoding.AbiEncoded, Operator.Matches), node(0, Encoding.EtherValue, Operator.WithinAllowance, hexOf(key))],
  };
}

/** weth.withdraw(amount): WETH9 pays the caller, so the ETH stays in the wallet. */
export function wethUnwrapSheet(weth: Hex): Sheet {
  return {
    target: weth,
    selector: SELECTORS.wethWithdraw,
    conditions: [node(0, Encoding.AbiEncoded, Operator.Matches), node(0, Encoding.Static, Operator.Pass)],
  };
}

export function aaveWithdrawSheet(pool: Hex, assets: Hex[]): Sheet {
  requireNonEmpty(assets, "asset");
  const { field, alternatives } = oneOf(0, assets);
  return {
    target: pool,
    selector: SELECTORS.aaveWithdraw,
    conditions: [
      node(0, Encoding.AbiEncoded, Operator.Matches),
      field,
      node(0, Encoding.Static, Operator.Pass),
      node(0, Encoding.Static, Operator.EqualToAvatar),
      ...withParent(alternatives, 1),
    ],
  };
}

/** The Omni Bridge recipient string for a NEAR account. */
export function nearRecipient(accountId: string): string {
  return `near:${accountId}`;
}

/** What the vault compares a string parameter with: keccak256 of its bytes. */
export function stringHash(text: string): Hex {
  return keccak256(toBytes(text));
}

/** Largest bridge fee (paid in ETH to the Omni Bridge relayer) a revenue transfer may carry. */
export const MAX_BRIDGE_FEE_WEI = 1_000_000_000_000_000n; // 0.001 ETH

/**
 * ETH from the company wallet to the company's shares contract on NEAR, through
 * the Omni Bridge, and nowhere else: native ETH, no token fee, the recipient
 * fixed to `near:<shares account>`, no message. The ETH sent (amount + bridge
 * fee) is counted against the budget.
 */
export function shareRevenueSheet(bridge: Hex, sharesAccountId: string, key: number[], maxBridgeFeeWei = MAX_BRIDGE_FEE_WEI): Sheet {
  return {
    target: bridge,
    selector: SELECTORS.initTransfer,
    conditions: [
      node(0, Encoding.AbiEncoded, Operator.Matches),
      node(0, Encoding.Static, Operator.EqualTo, addressWord(NATIVE_ETH.address)),
      node(0, Encoding.Static, Operator.GreaterThan, word(0n)),
      node(0, Encoding.Static, Operator.EqualTo, word(0n)),
      node(0, Encoding.Static, Operator.LessThan, word(maxBridgeFeeWei + 1n)),
      node(0, Encoding.Dynamic, Operator.EqualTo, stringHash(nearRecipient(sharesAccountId))),
      node(0, Encoding.Dynamic, Operator.EqualTo, stringHash("")),
      node(0, Encoding.EtherValue, Operator.WithinAllowance, hexOf(key)),
    ],
  };
}

const INIT_TRANSFER_ABI = parseAbi([
  "function initTransfer(address tokenAddress, uint128 amount, uint128 fee, uint128 nativeFee, string recipient, string message)",
]);

/** The call an agent sends to share revenue: what the role above allows. */
export function shareRevenueCall(bridge: Hex, sharesAccountId: string, amountWei: bigint, bridgeFeeWei: bigint) {
  const value = amountWei + bridgeFeeWei;
  return {
    to: getAddress(bridge),
    data: encodeFunctionData({
      abi: INIT_TRANSFER_ABI,
      functionName: "initTransfer",
      args: [NATIVE_ETH.address, amountWei, 0n, bridgeFeeWei, nearRecipient(sharesAccountId), ""],
    }),
    value: value.toString(),
    allowanceAmount: value.toString(),
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
  /** Send ETH to the company's shareholders, through the Omni Bridge. Budget in ETH. */
  | { kind: "share-revenue"; sharesAccountId: string; budget: Budget }
  | {
      kind: "swap";
      tokenIn: Hex;
      tokensOut: Hex[];
      protocols: ProtocolId[];
      budget: Budget;
      /** Largest single approval to a router, in tokenIn units. */
      maxApproval: string;
      /** Sealed orders may fill through this role too (contracts/sealed-orders joins it as a member). */
      sealedOrders?: boolean;
    }
  /** Deposit `token` into a lending pool (budget) and withdraw it back to the wallet. */
  | { kind: "lending"; protocol: LendingId; token: Hex; budget: Budget; maxApproval: string }
  /** Wrap ETH into WETH (budget in ETH) and unwrap it back, both in the wallet. */
  | { kind: "wrap"; budget: Budget }
  /** Send SOL or an SPL token on Solana to listed wallets (base58), within a budget. */
  | { kind: "solana-transfer"; token: string | null; recipients: Array<{ address: string; label: string }>; budget: Budget }
  /**
   * Send a NEP-141 token held by the vault account (NEAR) to listed accounts,
   * such as agents' spending cards. Amounts in token units ("5" = 5 USDC).
   */
  | {
      kind: "near-transfer";
      token: string;
      receivers: Array<{ accountId: string; label: string }>;
      budget: Budget;
      maxPerTransfer: string;
      /** Defaults to budget / NEAR_DEFAULT_TRANSFERS_PER_PERIOD (at least one base unit). */
      minPerTransfer?: string;
    };

export type RoleMember = { accountId: string; kind: MembershipKind; maxUses?: number | null; endsAt?: Date | null };

export type RoleDraft = {
  guardRequired?: boolean;
  suppliersOnly?: boolean;
  name: string;
  blocks: RoleBlock[];
  members: RoleMember[];
  /**
   * Set when the role already has NEAR permissions on the vault and the draft
   * has none: emits an empty SetNearPermissions so the old ones do not stay.
   * Only vaults with NEAR transfers know that change.
   */
  clearNearPermissions?: boolean;
  /** Editing a role: the role has Solana rights and the draft none, so they are cleared. */
  clearSolanaPermissions?: boolean;
  /**
   * Editing a role: budgets (allowance keys, 0x hex) left as they are. Their SetAllowance is not
   * re-sent, so what was already spent this period stays spent.
   */
  keepBudgets?: Hex[];
  /** Editing a role: members removed from it. */
  revokeMembers?: string[];
  gas?: Partial<Pick<RoleConfig, "gas_limit" | "max_fee_per_gas" | "max_priority_fee_per_gas" | "max_total_fee">>;
};

/**
 * A swap block that allows sealed orders makes contracts/sealed-orders a member of the role, unless it
 * already is one. The server and the browser both apply this, so the browser can check the proposal.
 */
export function withSealedOrdersMember(draft: RoleDraft, sealedId: string | null, alreadyMember: boolean): RoleDraft {
  if (!draft.blocks.some((block) => block.kind === "swap" && block.sealedOrders)) return draft;
  if (!sealedId) throw new Error("sealed orders are not configured on this server");
  if (alreadyMember || draft.members.some((member) => member.accountId === sealedId)) return draft;
  return { ...draft, members: [...draft.members, { accountId: sealedId, kind: "Agent", maxUses: null }] };
}

const DEFAULT_GAS = {
  gas_limit: "300000",
  max_fee_per_gas: "100000000000",
  max_priority_fee_per_gas: "10000000000",
  max_total_fee: "30000000000000000",
};

const BRIDGE_GAS = {
  gas_limit: "1000000",
  max_fee_per_gas: "20000000000",
  max_priority_fee_per_gas: "2000000000",
  max_total_fee: "20000000000000000",
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
  const solana: SolanaPermission[] = [];
  const near: NearPermission[] = [];
  const toPermission = (sheet: Sheet): Permission => ({
    chain_id: profile.chainId,
    target: bytes(getAddress(sheet.target)),
    selector: bytes(sheet.selector),
    conditions: sheet.conditions,
    allow_value: false,
  });
  const keep = new Set((draft.keepBudgets ?? []).map((key) => key.toLowerCase()));
  draft.blocks.forEach((block, index) => {
    const label = `${block.kind}-${index + 1}`;
    const key = allowanceKey(draft.name, label);
    const token = block.kind === "solana-transfer"
      ? (() => { const sol = solanaTokenOf(SOLANA_DEVNET, block.token); return { address: NATIVE_ETH.address, symbol: sol.symbol, decimals: sol.decimals }; })()
      : block.kind === "near-transfer"
      ? (() => { const ft = nearTokenOf(block.token); return { address: NATIVE_ETH.address, symbol: ft.symbol, decimals: ft.decimals }; })()
      : block.kind === "share-revenue" || block.kind === "wrap" ? NATIVE_ETH : tokenOf(profile, block.kind === "swap" ? block.tokenIn : block.token);
    const amount = parseUnits(block.budget.amount, token.decimals);
    if (amount <= 0n) throw new Error("budget must be positive");
    if (!(block.budget.periodDays > 0)) throw new Error("budget period must be positive");
    if (!keep.has(hexOf(key).toLowerCase())) changes.push({
      SetAllowance: {
        key,
        balance: amount.toString(),
        refill: amount.toString(),
        max_refill: amount.toString(),
        period_ns: Math.round(block.budget.periodDays * NS_PER_DAY),
      },
    });
    if (block.kind === "payments") {
      permissions.push(toPermission(draft.suppliersOnly ? {
        target: token.address, selector: SELECTORS.transfer, conditions: [
          node(0, Encoding.AbiEncoded, Operator.Matches),
          node(0, Encoding.Static, Operator.InAddressList, toHex(toBytes("suppliers"))),
          node(0, Encoding.Static, Operator.WithinAllowance, toHex(Uint8Array.from(key))),
        ],
      } : erc20TransferSheet(token.address, block.recipients.map((item) => item.address), key)));
    } else if (block.kind === "lending") {
      const lending = profile.lending?.[block.protocol];
      if (!lending) throw new Error(`no ${block.protocol} pool known on ${profile.name}`);
      if (!lending.assets.some((asset) => asset.toLowerCase() === token.address.toLowerCase())) {
        throw new Error(`${token.symbol} cannot be deposited on ${lending.name} on ${profile.name}`);
      }
      permissions.push(toPermission(erc20ApproveSheet(token.address, [lending.pool], parseUnits(block.maxApproval, token.decimals))));
      permissions.push(toPermission(aaveSupplySheet(lending.pool, [token.address], key)));
      permissions.push(toPermission(aaveWithdrawSheet(lending.pool, [token.address])));
    } else if (block.kind === "solana-transfer") {
      requireNonEmpty(block.recipients, "Solana recipient");
      if (block.recipients.length > 32) throw new Error("at most 32 Solana recipients");
      solana.push({
        asset: solanaAsset(solanaTokenOf(SOLANA_DEVNET, block.token)),
        recipients: block.recipients.map((recipient) => solanaAddress(recipient.address)),
        allowance: key,
      });
    } else if (block.kind === "near-transfer") {
      requireNonEmpty(block.receivers, "NEAR receiver");
      if (block.receivers.length > 32) throw new Error("at most 32 NEAR receivers");
      for (const receiver of block.receivers) {
        if (!validNearAccountId(receiver.accountId)) throw new Error(`${receiver.accountId} is not a NEAR account id`);
      }
      const ft = nearTokenOf(block.token);
      // parseUnits rounds beyond the token's decimals: refuse instead.
      for (const value of [block.budget.amount, block.maxPerTransfer, block.minPerTransfer ?? ""]) {
        if ((value.split(".")[1]?.length ?? 0) > ft.decimals) throw new Error(`${ft.symbol} has ${ft.decimals} decimals: ${value} is too precise`);
      }
      const max = parseUnits(block.maxPerTransfer, ft.decimals);
      // Never above the cap: a small cap keeps a floor the agent can still pay.
      const floor = amount / NEAR_DEFAULT_TRANSFERS_PER_PERIOD;
      const min = block.minPerTransfer ? parseUnits(block.minPerTransfer, ft.decimals) : floor < 1n ? 1n : floor > max ? max : floor;
      if (min <= 0n) throw new Error("the smallest transfer must be positive");
      if (min > max) throw new Error("the smallest transfer is above the largest");
      if (max > amount) throw new Error("the largest transfer is above the budget");
      near.push({
        token: ft.accountId,
        receivers: [...new Set(block.receivers.map((receiver) => receiver.accountId))],
        allowance: key,
        min_per_transfer: min.toString(),
        max_per_transfer: max.toString(),
      });
    } else if (block.kind === "wrap") {
      if (!profile.weth) throw new Error(`no WETH known on ${profile.name}`);
      permissions.push({ ...toPermission(wethWrapSheet(profile.weth, key)), allow_value: true });
      permissions.push(toPermission(wethUnwrapSheet(profile.weth)));
    } else if (block.kind === "share-revenue") {
      if (!profile.omniBridge) throw new Error(`no Omni Bridge known on ${profile.name}`);
      if (!/^[a-z0-9._-]{2,64}$/.test(block.sharesAccountId)) throw new Error("shares account is not a NEAR account id");
      permissions.push({ ...toPermission(shareRevenueSheet(profile.omniBridge, block.sharesAccountId, key)), allow_value: true });
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
        guard_required: draft.guardRequired ?? false,
        permissions,
        // Humans set the constraints; operations are allowed or refused by policy alone.
        operation_delay_threshold: null,
        operation_delay_ns: 0,
        co_sign_threshold: null,
        co_signer_role: null,
        velocity: null,
        ...DEFAULT_GAS,
        // A bridge transfer needs more gas than a token transfer; the total fee stays capped.
        ...(draft.blocks.some((block) => block.kind === "share-revenue") ? BRIDGE_GAS : {}),
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
  for (const member of draft.revokeMembers ?? []) changes.push({ RevokeMembership: { role: draft.name, member } });
  // Only roles that use Solana carry it: older vaults do not know this change.
  if (solana.length > 0) changes.push({ SetSolanaPermissions: { role: draft.name, permissions: solana } });
  else if (draft.clearSolanaPermissions) changes.push({ SetSolanaPermissions: { role: draft.name, permissions: [] } });
  // Same for NEAR tokens. The vault registers on each token first, so it can hold it.
  if (near.length > 0) {
    for (const token of new Set(near.map((permission) => permission.token))) changes.push({ NearStorageDeposit: { token } });
    changes.push({ SetNearPermissions: { role: draft.name, permissions: near } });
  } else if (draft.clearNearPermissions) {
    changes.push({ SetNearPermissions: { role: draft.name, permissions: [] } });
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

/** An EVM transaction the DAO votes on directly (outside any role). */
export type DaoTransactionDraft = {
  chainId: number;
  to: Hex;
  value: string;
  data: Hex;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
};

export type VaultCall =
  | { method: "queue_rule_change"; change: RuleChange }
  | { method: "request_wallet"; chainId: number }
  | { method: "request_solana_wallet" }
  | { method: "pause" | "unpause" }
  | { method: "submit_transactions"; transactions: DaoTransactionDraft[] };

const DAO_TRANSACTIONS_GAS = "100000000000000"; // 100 Tgas

const bytesOf = (hex: Hex): number[] => Array.from(toBytes(hex));
const hexOfBytes = (bytes: number[]): Hex => toHex(Uint8Array.from(bytes));

export function proposalArgs(vaultAccountId: string, title: string, calls: VaultCall[]) {
  requireNonEmpty(calls, "vault call");
  const actions = calls.map((call) => {
    const args = call.method === "queue_rule_change"
      ? { change: call.change }
      : call.method === "request_wallet"
        ? { chain_id: call.chainId }
        : call.method === "submit_transactions"
          ? {
            transactions: call.transactions.map((transaction) => ({
              chain_id: transaction.chainId,
              target: bytesOf(getAddress(transaction.to)),
              value: transaction.value,
              calldata: bytesOf(transaction.data),
              gas_limit: transaction.gasLimit,
              max_fee_per_gas: transaction.maxFeePerGas,
              max_priority_fee_per_gas: transaction.maxPriorityFeePerGas,
            })),
          }
          : {};
    return {
      method_name: call.method,
      args: btoa(JSON.stringify(args)),
      deposit: "0",
      gas: call.method === "request_wallet" || call.method === "request_solana_wallet" ? WALLET_GAS : call.method === "submit_transactions" ? DAO_TRANSACTIONS_GAS : RULE_GAS,
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

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

export const SHAREHOLDERS_ROLE = "shareholders";
/** What shareholders vote on: company calls (the vault: roles, transactions) and NEAR transfers. */
export const SHAREHOLDER_KINDS = ["call", "transfer"] as const;
const SHAREHOLDER_ACTIONS = ["AddProposal", "VoteApprove", "VoteReject", "Finalize"] as const;
const TOKEN_MAJORITY = { weight_kind: "TokenWeight", quorum: "0", threshold: [1, 2] };

/**
 * Shareholders vote with their locked shares: a company call or transfer passes
 * with more than half of all locked shares. Members still pass anything by two
 * thirds, and any member can veto a vault change during the veto window.
 */
export function shareholdersRole(): DaoPolicy["roles"][number] {
  return {
    name: SHAREHOLDERS_ROLE,
    kind: { Member: "1" },
    permissions: SHAREHOLDER_KINDS.flatMap((kind) => SHAREHOLDER_ACTIONS.map((action) => `${kind}:${action}`)),
    vote_policy: Object.fromEntries(SHAREHOLDER_KINDS.map((kind) => [kind, { ...TOKEN_MAJORITY }])),
  };
}

/** Sputnik returns permissions and vote policies in any order: compare their content. */
function isShareholdersRole(role: DaoPolicy["roles"][number]): boolean {
  const expected = shareholdersRole();
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((item) => b.includes(item));
  const votes = Object.entries(role.vote_policy ?? {});
  return role.name === expected.name
    && JSON.stringify(role.kind) === JSON.stringify(expected.kind)
    && sameSet(role.permissions ?? [], expected.permissions)
    && sameSet(votes.map(([kind]) => kind), Object.keys(expected.vote_policy))
    && votes.every(([, vote]) => JSON.stringify(vote) === JSON.stringify(TOKEN_MAJORITY));
}

/** True when a DAO policy (as returned by `get_policy`) already lets shareholders vote. */
export function hasShareholdersRole(policy: { roles: DaoPolicy["roles"] }): boolean {
  return policy.roles.some(isShareholdersRole);
}

export type SharesConfig = {
  name: string;
  symbol: string;
  totalSupply: number;
  /** Price of one share, in yoctoNEAR. */
  pricePerShareYocto: string;
  unlockPeriodNs: string;
  /** Revenue is split by epoch among the holders who voted: 1 hour on testnet, 7 days in production. */
  epochNs: string;
  revenueToken: string | null;
  allocations: Array<[string, number]>;
};

/** Init arguments of the shares contract. */
export function sharesInitArgs(daoAccountId: string, config: SharesConfig) {
  if (!/^[A-Z0-9]{2,8}$/.test(config.symbol)) throw new Error("symbol must be 2 to 8 capital letters or digits");
  if (!Number.isInteger(config.totalSupply) || config.totalSupply < 1) throw new Error("total supply must be a positive whole number");
  const allocated = config.allocations.reduce((sum, [, amount]) => sum + amount, 0);
  if (allocated > config.totalSupply) throw new Error("allocations exceed the total supply");
  return {
    dao_id: daoAccountId,
    name: config.name,
    symbol: config.symbol,
    total_supply: String(config.totalSupply),
    price_per_share: config.pricePerShareYocto,
    unlock_period_ns: config.unlockPeriodNs,
    epoch_ns: config.epochNs,
    revenue_token: config.revenueToken,
    allocations: config.allocations.map(([account, amount]) => [account, String(amount)]),
  };
}

/** The two votes that turn shares on: the DAO counts them, and shareholders get a role. */
export function sharesProposalKinds(sharesAccountId: string) {
  return [
    { title: `Count locked shares of ${sharesAccountId} as votes`, kind: { SetStakingContract: { staking_id: sharesAccountId } } },
    { title: "Let shareholders vote on company calls and transfers", kind: { ChangePolicyAddOrUpdateRole: { role: shareholdersRole() } } },
  ];
}

export function proposalOf(title: string, kind: unknown) {
  return { proposal: { description: `${PROPOSAL_MARKER} ${title}`, kind } };
}

const YOCTO = 10n ** 24n;
export function formatNear(yocto: string | bigint): string {
  const value = BigInt(yocto);
  const whole = value / YOCTO;
  const fraction = (value % YOCTO).toString().padStart(24, "0").slice(0, 4).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction} NEAR` : `${whole} NEAR`;
}

export function parseNear(amount: string): string {
  const match = /^(\d+)(?:\.(\d{1,24}))?$/.exec(amount.trim());
  if (!match) throw new Error(`${amount} is not a NEAR amount`);
  return (BigInt(match[1]!) * YOCTO + BigInt((match[2] ?? "").padEnd(24, "0"))).toString();
}

/** Share the DAO's NEAR with shareholders: a call to the shares contract, paid from the DAO. */
export function revenueProposalKind(sharesAccountId: string, amountYocto: string) {
  return {
    FunctionCall: {
      receiver_id: sharesAccountId,
      actions: [{ method_name: "deposit_revenue", args: btoa("{}"), deposit: amountYocto, gas: "30000000000000" }],
    },
  };
}

// ---------------------------------------------------------------------------
// NEAR held by the DAO → the company wallet on an EVM chain (Omni Bridge)
// ---------------------------------------------------------------------------

/** Omni Bridge accounts on NEAR testnet (github.com/Near-One/omni-bridge). */
export const OMNI_NEAR_TESTNET = { bridge: "omni.n-bridge.testnet", wrappedNear: "wrap.testnet" } as const;

/** Omni Bridge chain prefixes and their OmniAddress variant (borsh index). */
export const OMNI_CHAINS: Record<number, { prefix: "eth" | "base"; variant: number; name: string }> = {
  11155111: { prefix: "eth", variant: 0, name: "Ethereum Sepolia" },
  84532: { prefix: "base", variant: 4, name: "Base Sepolia" },
};

export function omniRecipient(chainId: number, wallet: Hex): string {
  const chain = OMNI_CHAINS[chainId];
  if (!chain) throw new Error(`Omni Bridge does not serve chain ${chainId} here`);
  return `${chain.prefix}:${getAddress(wallet).toLowerCase()}`;
}

const u32le = (value: number): Hex => toHex(Uint8Array.from([value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255]));
const u128le = (value: bigint): Hex => toHex(Uint8Array.from({ length: 16 }, (_, index) => Number((value >> BigInt(8 * index)) & 255n)));
const borshString = (text: string): Hex => concatHex([u32le(toBytes(text).length), toHex(toBytes(text))]);

/**
 * The bridge charges a transfer's storage to its signer (the member casting
 * the final vote) or to a "message account" derived from the transfer itself
 * (omni-types `TransferMessageStorageAccount::id`). The DAO funds that account
 * first, so no member pays.
 */
export function omniMessageAccount(input: { token: string; amount: bigint; chainId: number; wallet: Hex; fee: bigint; sender: string }): string {
  const chain = OMNI_CHAINS[input.chainId];
  if (!chain) throw new Error(`Omni Bridge does not serve chain ${input.chainId} here`);
  const bytes = concatHex([
    "0x01", borshString(input.token), // token: OmniAddress::Near
    u128le(input.amount),
    toHex(Uint8Array.from([chain.variant])), getAddress(input.wallet), // recipient
    u128le(input.fee), u128le(0n), // fee in token, native fee
    "0x01", borshString(input.sender), // sender: OmniAddress::Near
    borshString(""), // msg
  ]);
  return sha256(bytes).slice(2);
}

const b64json = (value: object) => btoa(JSON.stringify(value));

/**
 * Two votes: pay the bridge storage (the members who may cast the final vote,
 * and this transfer), then wrap the NEAR and send it to the company wallet.
 */
export function proceedsToEvmKinds(input: {
  daoAccountId: string;
  chainId: number;
  wallet: Hex;
  amountYocto: string;
  feeYocto: string;
  membersToRegister: string[];
  perAccountYocto: string;
  perTransferYocto: string;
  accounts?: { bridge: string; wrappedNear: string };
}) {
  const accounts = input.accounts ?? OMNI_NEAR_TESTNET;
  const recipient = omniRecipient(input.chainId, input.wallet);
  const messageAccount = omniMessageAccount({
    token: accounts.wrappedNear, amount: BigInt(input.amountYocto), chainId: input.chainId, wallet: input.wallet, fee: BigInt(input.feeYocto), sender: input.daoAccountId,
  });
  if (BigInt(input.feeYocto) >= BigInt(input.amountYocto)) throw new Error("the bridge fee is above the amount");
  const storage = {
    FunctionCall: {
      receiver_id: accounts.bridge,
      actions: [
        ...input.membersToRegister.map((member) => ({ method_name: "storage_deposit", args: b64json({ account_id: member }), deposit: input.perAccountYocto, gas: "10000000000000" })),
        { method_name: "storage_deposit", args: b64json({ account_id: messageAccount }), deposit: input.perTransferYocto, gas: "10000000000000" },
      ],
    },
  };
  const transfer = {
    FunctionCall: {
      receiver_id: accounts.wrappedNear,
      actions: [
        { method_name: "near_deposit", args: b64json({}), deposit: input.amountYocto, gas: "10000000000000" },
        {
          method_name: "ft_transfer_call",
          args: b64json({ receiver_id: accounts.bridge, amount: input.amountYocto, memo: null, msg: JSON.stringify({ recipient, fee: input.feeYocto, native_token_fee: "0" }) }),
          deposit: "1",
          gas: "150000000000000",
        },
      ],
    },
  };
  return { messageAccount, recipient, storage, transfer };
}

/** Describe the two votes above; null for anything else. */
export function describeProceedsProposal(kind: unknown, companyWallet: Hex | null): { title: string; details: string[] } | null {
  const call = (kind as { FunctionCall?: { receiver_id?: string; actions?: Array<{ method_name: string; args: string; deposit: string }> } })?.FunctionCall;
  if (!call?.actions?.length) return null;
  if (call.receiver_id === OMNI_NEAR_TESTNET.bridge && call.actions.every((action) => action.method_name === "storage_deposit")) {
    const total = call.actions.reduce((sum, action) => sum + BigInt(action.deposit), 0n);
    return { title: `Pay ${formatNear(total)} of Omni Bridge storage`, details: ["for the members who may cast the final vote and for the transfer to the company wallet", "paid from the DAO account"] };
  }
  const transfer = call.actions.find((action) => action.method_name === "ft_transfer_call");
  if (call.receiver_id === OMNI_NEAR_TESTNET.wrappedNear && transfer) {
    const args = JSON.parse(atob(transfer.args)) as { receiver_id: string; amount: string; msg: string };
    const msg = JSON.parse(args.msg) as { recipient: string; fee: string };
    const [prefix, address] = msg.recipient.split(":");
    const chain = Object.values(OMNI_CHAINS).find((item) => item.prefix === prefix)?.name ?? prefix;
    const ours = Boolean(companyWallet && address && address.toLowerCase() === companyWallet.toLowerCase());
    return {
      title: `Send ${formatNear(args.amount)} to the company wallet on ${chain}`,
      details: [
        `as wNEAR, through Omni Bridge (${args.receiver_id})`,
        `to ${address}${ours ? " (company wallet)" : ""}`,
        `bridge fee ${formatNear(msg.fee)}, taken from the amount`,
        ...(ours ? [] : ["⚠ this is not the company wallet"]),
      ],
    };
  }
  return null;
}

/** Base64 of a JSON value, UTF-8 safe (names can hold any character). */
function jsonBase64(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function jsonFromBase64(value: string): unknown {
  const binary = atob(value);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
}

/** Storage deposit attached to a directory listing; the registry refunds what it does not use. */
export const REGISTRY_DEPOSIT_YOCTO = "20000000000000000000000";
export const REGISTRY_NAME_MAX = 64;
export const REGISTRY_DESCRIPTION_MAX = 280;

export type DirectoryListing = { vaultAccountId: string; sharesAccountId: string | null; name: string; description: string };

/** The DAO lists the company in the public directory (contracts/registry). */
export function registryProposalKind(registryId: string, listing: DirectoryListing) {
  const name = listing.name.trim();
  if (!name || [...name].length > REGISTRY_NAME_MAX) throw new Error(`the name must be 1 to ${REGISTRY_NAME_MAX} characters`);
  if ([...listing.description].length > REGISTRY_DESCRIPTION_MAX) throw new Error(`the description must be at most ${REGISTRY_DESCRIPTION_MAX} characters`);
  return {
    FunctionCall: {
      receiver_id: registryId,
      actions: [{
        method_name: "register",
        args: jsonBase64({ vault_id: listing.vaultAccountId, shares_id: listing.sharesAccountId, name, description: listing.description }),
        deposit: REGISTRY_DEPOSIT_YOCTO,
        gas: "100000000000000",
      }],
    },
  };
}

/** Describe a directory listing proposal; null for anything else. */
export function describeRegistryProposal(kind: unknown, registryId: string | null): { title: string; details: string[] } | null {
  const call = (kind as { FunctionCall?: { receiver_id?: string; actions?: Array<{ method_name: string; args: string }> } })?.FunctionCall;
  if (!registryId || call?.receiver_id !== registryId || !call.actions?.length) return null;
  const action = call.actions[0]!;
  if (action.method_name === "unregister") return { title: "Leave the public directory of AI companies", details: [`registry ${registryId}`] };
  if (action.method_name !== "register") return null;
  const args = jsonFromBase64(action.args) as { vault_id: string; shares_id: string | null; name: string; description: string };
  return {
    title: `List "${args.name}" in the public directory of AI companies`,
    details: [
      args.description ? `description: ${args.description}` : "no description",
      `vault ${args.vault_id}${args.shares_id ? `, shares ${args.shares_id}` : ""}`,
      "the registry checks on chain that both belong to this DAO",
    ],
  };
}

/** Describe the proposals about shares; null for anything else. */
export function describeSharesProposal(kind: unknown, sharesAccountId: string | null): { title: string; details: string[] } | null {
  const staking = (kind as { SetStakingContract?: { staking_id?: string } })?.SetStakingContract;
  if (staking) {
    const known = staking.staking_id === sharesAccountId;
    return {
      title: "Votes count locked shares",
      details: [
        `vote weight comes from ${staking.staking_id}`,
        "can be set only once for this DAO",
        ...(known ? [] : ["⚠ this is not the company's shares contract"]),
      ],
    };
  }
  const role = (kind as { ChangePolicyAddOrUpdateRole?: { role?: DaoPolicy["roles"][number] } })?.ChangePolicyAddOrUpdateRole?.role;
  if (role) {
    const standard = isShareholdersRole(role);
    return {
      title: standard ? "Shareholders vote on company calls and transfers" : `Add or change role "${role.name}"`,
      details: standard
        ? ["passes with more than half of all locked shares", "members still decide by two thirds and can veto vault changes"]
        : [`⚠ role "${role.name}" open to ${JSON.stringify(role.kind)} with ${role.permissions.join(", ")}`],
    };
  }
  const call = (kind as { FunctionCall?: { receiver_id?: string; actions?: Array<{ method_name: string; deposit: string }> } })?.FunctionCall;
  if (call && sharesAccountId && call.receiver_id === sharesAccountId && call.actions?.length === 1 && call.actions[0]?.method_name === "deposit_revenue") {
    return {
      title: `Share ${formatNear(call.actions[0].deposit)} with shareholders`,
      details: ["paid from the DAO account", "goes to this epoch's revenue: split among the holders who vote, pro rata of their locked shares"],
    };
  }
  return null;
}

/** The only policy Euthyna creates: one council group, two-thirds threshold, and shareholders once shares exist. */
export function councilPolicy(
  members: string[],
  settings: { proposalBond: string; proposalPeriodNs: string },
  options: { shareholders?: boolean } = {},
): DaoPolicy {
  if (members.length < 3) throw new Error("at least three members are needed");
  if (new Set(members).size !== members.length) throw new Error("a member is listed twice");
  return {
    roles: [
      { name: COUNCIL_ROLE, kind: { Group: members }, permissions: [...COUNCIL_PERMISSIONS], vote_policy: {} },
      ...(options.shareholders ? [shareholdersRole()] : []),
    ],
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
  const others = policy.roles.filter((role) => role.name !== COUNCIL_ROLE && !isShareholdersRole(role));
  const councils = policy.roles.filter((role) => role.name === COUNCIL_ROLE);
  if (councils.length !== 1 || others.length) warnings.push(`⚠ unusual roles: ${policy.roles.map((role) => role.name).join(", ")}`);
  for (const role of [...councils, ...others]) {
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
  const shareholders = policy.roles.some(isShareholdersRole);
  return {
    title: `Members become: ${members.join(", ")}`,
    details: [
      `a decision will need ${threshold} of ${members.length} approvals`,
      ...(shareholders ? ["shareholders keep their vote on company calls and transfers"] : []),
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
    if (action.method_name === "request_solana_wallet") return { method: "request_solana_wallet" };
    if (action.method_name === "pause" || action.method_name === "unpause") return { method: action.method_name };
    if (action.method_name === "submit_transactions") {
      const transactions = (args.transactions as Array<Record<string, unknown>>).map((transaction) => ({
        chainId: Number(transaction.chain_id),
        to: getAddress(hexOfBytes(transaction.target as number[])),
        value: String(transaction.value),
        data: hexOfBytes(transaction.calldata as number[]),
        gasLimit: String(transaction.gas_limit),
        maxFeePerGas: String(transaction.max_fee_per_gas),
        maxPriorityFeePerGas: String(transaction.max_priority_fee_per_gas),
      }));
      return { method: "submit_transactions", transactions };
    }
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

export function labelAddress(address: Hex, context: DescribeContext, kind: "recipient" | "contract" = "recipient"): string {
  const key = address.toLowerCase();
  const label = Object.entries(context.labels ?? {}).find(([candidate]) => candidate.toLowerCase() === key)?.[1];
  const full = getAddress(address);
  if (label) return context.fullAddresses ? `${label} (${full})` : label;
  const token = context.profile.tokens.find((item) => item.address.toLowerCase() === key);
  if (token) return token.symbol;
  const protocol = Object.values(context.profile.protocols).find((item) => item.router.toLowerCase() === key);
  if (protocol) return `${protocol.name} router`;
  const pool = Object.values(context.profile.lending ?? {}).find((item) => item?.pool.toLowerCase() === key);
  if (pool) return `${pool.name} pool`;
  const known = KNOWN_CONTRACTS[key];
  if (known) return context.fullAddresses ? `${known} (${full})` : known;
  return `${context.fullAddresses ? full : short(full)} (${kind === "contract" ? "unknown contract" : "not a registered supplier"})`;
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
    if ("SetSolanaPermissions" in change) {
      for (const permission of change.SetSolanaPermissions.permissions) {
        const mint = permission.asset === "Sol" ? null : base58Encode(permission.asset.Spl.mint);
        const sol = SOLANA_DEVNET.tokens.find((item) => item.mint === mint);
        result[hexOf(permission.allowance).toLowerCase()] = {
          token: sol ? { address: NATIVE_ETH.address, symbol: sol.symbol, decimals: sol.decimals } : undefined,
          label: `${change.SetSolanaPermissions.role} Solana transfers`,
        };
      }
      continue;
    }
    if ("SetNearPermissions" in change) {
      for (const permission of change.SetNearPermissions.permissions) {
        const ft = NEAR_TESTNET_TOKENS.find((item) => item.accountId === permission.token);
        result[hexOf(permission.allowance).toLowerCase()] = {
          token: ft ? { address: NATIVE_ETH.address, symbol: ft.symbol, decimals: ft.decimals } : undefined,
          label: `${change.SetNearPermissions.role} NEAR transfers`,
        };
      }
      continue;
    }
    if ("SetBankPermission" in change) {
      const permission = change.SetBankPermission.permission;
      if (permission) {
        result[hexOf(permission.allowance).toLowerCase()] = {
          token: profile.tokens.find((item) => item.symbol === "EURC"),
          label: `${change.SetBankPermission.role} euro payouts`,
        };
      }
      continue;
    }
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
        } else if (selector === SELECTORS.initTransfer) {
          token = NATIVE_ETH;
          kind = "revenue";
        } else if (selector === SELECTORS.wethDeposit) {
          token = NATIVE_ETH;
          kind = "wraps";
        } else if (selector === SELECTORS.aaveSupply) {
          const asset = permission.conditions[1];
          if (asset?.operator === Operator.EqualTo) token = findToken(wordToAddress(asset.compValue));
          kind = "deposits";
        }
        const key = condition.compValue.toLowerCase();
        const existing = result[key];
        // "payments" role + payments block → "payments", not "payments payments".
        result[key] = { token: existing?.token ?? token, label: role === kind ? role : `${role} ${kind}` };
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
  const lendingAsset = (selector === SELECTORS.aaveSupply || selector === SELECTORS.aaveWithdraw) && conditions[1]?.operator === Operator.EqualTo
    ? context.profile.tokens.find((item) => item.address.toLowerCase() === wordToAddress(conditions[1]!.compValue).toLowerCase())
    : undefined;
  const amountToken = (name: string): Token | undefined => {
    if (lendingAsset && name === "amount") return lendingAsset;
    if (selector === SELECTORS.initTransfer && (name === "bridge fee" || name === "ETH sent" || name === "amount")) return NATIVE_ETH;
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
      case Operator.InAddressList:
        rules.push(`${name} must belong to the on-chain address list`);
        return;
      case Operator.EqualToAvatar:
        rules.push(`${name} must be the company wallet`);
        return;
      case Operator.EqualTo:
        if (item.paramType === Encoding.Array) {
          rules.push(`${name} must be ${routeName(item.compValue, context) ?? "an approved route"}`);
        } else if (item.paramType === Encoding.Static && /^0x0{64}$/i.test(item.compValue)) {
          rules.push(name === "token" ? "token must be ETH itself (native)" : `${name} must be zero`);
        } else if (item.paramType === Encoding.Static && /^0x0{24}/i.test(item.compValue)) {
          rules.push(`${name} must be ${labelAddress(wordToAddress(item.compValue), context)}`);
        } else if (item.paramType === Encoding.Dynamic) {
          const text = item.compValue.toLowerCase() === stringHash("").toLowerCase()
            ? "empty"
            : Object.entries(context.labels ?? {}).find(([candidate]) => candidate.toLowerCase() === item.compValue.toLowerCase())?.[1];
          rules.push(text ? (text === "empty" ? `${name} must be empty` : `${name} must be ${text}`) : `${name} must be the text whose hash is ${item.compValue}`);
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
  if ("AddListAddresses" in change) return { title: `Add ${change.AddListAddresses.entries.length} addresses to ${change.AddListAddresses.list}`, details: change.AddListAddresses.entries.map((e) => `${e.label}: ${hexOf(e.address)}`) };
  if ("AddListAddress" in change) return { title: `Add ${change.AddListAddress.label} to ${change.AddListAddress.list}`, details: [hexOf(change.AddListAddress.address)] };
  if ("RemoveListAddress" in change) return { title: `Remove an address from ${change.RemoveListAddress.list}`, details: [hexOf(change.RemoveListAddress.address)] };
  if ("SetSettlementConfig" in change) return { title: "Change settlement timeouts", details: [JSON.stringify(change.SetSettlementConfig.config)] };
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
  if ("SetSolanaPermissions" in change) {
    const { role, permissions } = change.SetSolanaPermissions;
    const details = permissions.map((permission) => {
      const mint = permission.asset === "Sol" ? null : base58Encode(permission.asset.Spl.mint);
      const token = SOLANA_DEVNET.tokens.find((item) => item.mint === mint)?.symbol ?? mint ?? "SOL";
      const budget = context.budgets?.[hexOf(permission.allowance).toLowerCase()];
      return `Send ${token} on Solana to ${permission.recipients.map((recipient) => base58Encode(recipient)).join(", ")}${budget ? `, within budget "${budget.label}"` : ""}`;
    });
    return { title: permissions.length ? `Let role "${role}" send on Solana` : `Remove Solana transfers from role "${role}"`, details };
  }
  if ("SetNearPermissions" in change) {
    const { role, permissions } = change.SetNearPermissions;
    const details = permissions.map((permission) => {
      const ft = NEAR_TESTNET_TOKENS.find((item) => item.accountId === permission.token);
      const units = (value: string) => ft ? `${Number(formatUnits(BigInt(value), ft.decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${ft.symbol}` : `${value} base units`;
      const budget = context.budgets?.[hexOf(permission.allowance).toLowerCase()];
      return `Send ${ft?.symbol ?? permission.token} on NEAR to ${permission.receivers.join(", ")}, from ${units(permission.min_per_transfer)} to ${units(permission.max_per_transfer)} per transfer${budget ? `, within budget "${budget.label}"` : ""}`;
    });
    return { title: permissions.length ? `Let role "${role}" send tokens on NEAR` : `Remove NEAR token transfers from role "${role}"`, details };
  }
  if ("NearStorageDeposit" in change) {
    const ft = NEAR_TESTNET_TOKENS.find((item) => item.accountId === change.NearStorageDeposit.token);
    return { title: `Register the vault on ${ft?.symbol ?? change.NearStorageDeposit.token} (NEAR)`, details: ["Pays the token's storage deposit (about 0.00125 NEAR) from the vault, so it can hold this token."] };
  }
  if ("Upgrade" in change) return { title: "Upgrade the vault to a published version", details: [`Code hash ${change.Upgrade.code_hash}: the vault deploys it only if the fetched code has this hash.`] };
  if ("SetCodeSource" in change) return { title: `Fetch future versions from ${change.SetCodeSource.account_id}`, details: ["An upgrade still deploys only code with the hash the DAO votes for."] };
  if ("SetBankConfig" in change) {
    const config = change.SetBankConfig.config;
    if (!config) return { title: "Disable euro payouts", details: [] };
    return { title: `Pay voted IBANs in euros through the bank signer on ${config.outlayer_id}`, details: [`Signer code ${config.signer_hash.slice(0, 16)}…, secrets ${config.secrets_owner}/${config.secrets_profile}.`, `Settles in ${config.crypto} on ${config.network} from the company wallet.`] };
  }
  if ("AddBankBeneficiary" in change) return { title: "Allow euro payouts to an IBAN in clear (refused by the vault)", details: ["An IBAN in clear would stay public on chain: vote a sealed beneficiary instead."] };
  if ("RemoveBankBeneficiary" in change) return { title: "Remove an IBAN of the first version", details: [] };
  if ("SetBankBoxKey" in change) {
    const key = change.SetBankBoxKey.key;
    return key
      ? { title: "Seal bank beneficiaries to the bank signer enclave", details: [`Enclave box key ${key.slice(0, 16)}…: only that enclave opens a beneficiary's IBAN. The IBANs of the first version are erased from the vault's state.`] }
      : { title: "Remove the bank signer's box key", details: [] };
  }
  if ("AddSealedBankBeneficiary" in change) {
    const entry = change.AddSealedBankBeneficiary;
    return {
      title: `Allow euro payouts to a sealed beneficiary${entry.label ? ` (${entry.label})` : ""}`,
      details: [`Commitment ${entry.commitment.slice(0, 16)}…: the IBAN and its holder are not on chain. Members read them with their reading key; only the bank signer enclave pays them, and only this IBAN.`],
    };
  }
  if ("RemoveSealedBankBeneficiary" in change) return { title: `Stop euro payouts to beneficiary #${change.RemoveSealedBankBeneficiary.id}`, details: [] };
  if ("AddStandingOrder" in change) {
    const order = change.AddStandingOrder;
    const days = Number(BigInt(order.period_ns) / 1_000_000n) / 86_400_000;
    const every = days === 1 ? "every day" : Number.isInteger(days) ? `every ${days} days` : `every ${Math.round(days * 1440)} minutes`;
    const first = new Date(Number(BigInt(order.first_at_ns) / 1_000_000n)).toISOString().slice(0, 16).replace("T", " ");
    return {
      title: `Pay beneficiary #${order.beneficiary_id} ${amountText(BigInt(order.amount), context.profile.tokens.find((token) => token.symbol === "EURC"))} ${every}${order.label ? ` (${order.label})` : ""}`,
      details: [`First on ${first} UTC${order.count ? `, ${order.count} times` : ", until the members stop it"}. The vault pays it on each date without another vote; the beneficiary's account stays sealed.`],
    };
  }
  if ("RemoveStandingOrder" in change) return { title: `Stop standing order #${change.RemoveStandingOrder.id}`, details: [] };
  if ("SetBankPermission" in change) {
    const permission = change.SetBankPermission.permission;
    if (!permission) return { title: `Remove euro payouts from role ${change.SetBankPermission.role}`, details: [] };
    return { title: `Let role ${change.SetBankPermission.role} pay voted IBANs in euros`, details: [`Up to ${amountText(BigInt(permission.max_per_payout), context.budgets?.[hexOf(permission.allowance).toLowerCase()]?.token)} per payout, charged to the ${budgetName(hexOf(permission.allowance), context)} budget.`] };
  }
  return { title: `Set policy version ${change.SetVersions.policy_version}, registry version ${change.SetVersions.registry_version}`, details: [] };
}

export function describeVaultCall(call: VaultCall, context: DescribeContext): { title: string; details: string[] } {
  if (call.method === "request_wallet") return { title: `Create the company wallet on ${call.chainId === context.profile.chainId ? context.profile.name : `chain ${call.chainId}`}`, details: [] };
  if (call.method === "request_solana_wallet") return { title: "Create the company wallet on Solana", details: ["Its address is an ed25519 key derived by NEAR MPC; nobody holds it."] };
  if (call.method === "pause") return { title: "Pause all operations", details: [] };
  if (call.method === "unpause") return { title: "Resume operations", details: [] };
  if (call.method === "queue_rule_change") return describeChange(call.change, context);
  if (call.method === "submit_transactions") return describeDaoTransactions(call.transactions, context);
  return { title: "Unknown vault call", details: [] };
}

/** Public contracts the console recognises in proposals (lowercase address → name). */
const KNOWN_CONTRACTS: Record<string, string> = {
  "0xfd0bf71f60660e2f608ed56e1659c450eb113120": "bridge to Base Sepolia",
  // NEAR Omni Bridge, testnet deployment (github.com/Near-One/omni-bridge README).
  "0xa56b860017152cd296ad723e8409abd6e5d86d4d": "NEAR Omni Bridge",
  "0x68a86e0ea5b1d39f385c1326e4d493526dfe4401": "NEAR Omni Bridge",
};

const CHAIN_NAMES: Record<number, string> = { 1: "Ethereum", 8453: "Base", 84532: "Base Sepolia", 11155111: "Ethereum Sepolia" };

export function chainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `chain ${chainId}`;
}

/**
 * A transaction voted outside any role, spelled out for the voters: what it
 * does, then the exact target, value, data and the most it can cost in fees.
 */
export function describeDaoTransactions(transactions: DaoTransactionDraft[], context: DescribeContext): { title: string; details: string[] } {
  const details = transactions.flatMap((transaction, index) => {
    const value = BigInt(transaction.value);
    const fee = BigInt(transaction.gasLimit) * BigInt(transaction.maxFeePerGas);
    const bytes = (transaction.data.length - 2) / 2;
    return [
      `${transactions.length > 1 ? `${index + 1}. ` : ""}${describeCall(transaction.to, transaction.data, value, context)} on ${chainName(transaction.chainId)}`,
      `  · to ${getAddress(transaction.to)}${value > 0n ? `, sends ${formatUnits(value, 18)} ETH` : ""}`,
      `  · data ${bytes === 0 ? "none" : `${transaction.data.slice(0, 10)}… (${bytes} bytes)`}`,
      `  · network fee at most ${formatUnits(fee, 18)} ETH`,
    ];
  });
  return {
    title: `Send ${transactions.length === 1 ? "a transaction" : `${transactions.length} transactions`} from the company wallet`,
    details: [...details, "Signed after the veto window, in this order, outside any role."],
  };
}

const POOL_ABI = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)",
  "function deposit()",
  "function depositETH(uint32 minGasLimit, bytes extraData)",
  "function initTransfer(address tokenAddress, uint128 amount, uint128 fee, uint128 nativeFee, string recipient, string message)",
  "function depositETHTo(address to, uint32 minGasLimit, bytes extraData)",
]);

const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

/** One sentence for a call an agent asked for (activity feed). */
export function describeCall(target: Hex, calldata: Hex, value: bigint, context: DescribeContext): string {
  const token = context.profile.tokens.find((item) => item.address.toLowerCase() === target.toLowerCase());
  const label = (address: Hex) => labelAddress(address, context);
  const contract = (address: Hex) => labelAddress(address, context, "contract");
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
        return `swap ${amountText(params.amountIn, tokenIn)} for ${label(params.tokenOut)} on ${contract(target)}, sent to ${label(params.recipient)}`;
      }
      const [amountIn, , path, to] = decoded.args;
      const tokenIn = context.profile.tokens.find((item) => item.address.toLowerCase() === path[0]?.toLowerCase());
      return `swap ${amountText(amountIn, tokenIn)} along ${path.map((hop) => label(hop)).join(" → ")} on ${contract(target)}, sent to ${label(to)}`;
    }
    const pool = (() => {
      try {
        return decodeFunctionData({ abi: POOL_ABI, data: calldata });
      } catch {
        return null;
      }
    })();
    if (pool) {
      const tokenOf = (address: Hex) => context.profile.tokens.find((item) => item.address.toLowerCase() === address.toLowerCase());
      if (pool.functionName === "supply") return `deposit ${amountText(pool.args[1], tokenOf(pool.args[0]))} into ${contract(target)} for ${label(pool.args[2])}`;
      if (pool.functionName === "withdraw") return `withdraw ${pool.args[1] >= 2n ** 255n ? "everything" : amountText(pool.args[1], tokenOf(pool.args[0]))} from ${contract(target)} to ${label(pool.args[2])}`;
      if (pool.functionName === "borrow") return `borrow ${amountText(pool.args[1], tokenOf(pool.args[0]))} from ${contract(target)} for ${label(pool.args[4])}`;
      if (pool.functionName === "repay") return `repay ${amountText(pool.args[1], tokenOf(pool.args[0]))} to ${contract(target)} for ${label(pool.args[3])}`;
      if (pool.functionName === "deposit") return `wrap ${formatUnits(value, 18)} ETH with ${contract(target)}`;
      if (pool.functionName === "depositETH") return `bridge ${formatUnits(value, 18)} ETH to the same address on the other chain, through ${contract(target)}`;
      if (pool.functionName === "initTransfer") {
        const [tokenAddress, amount, , nativeFee, recipient] = pool.args;
        const what = tokenAddress === "0x0000000000000000000000000000000000000000"
          ? `${formatUnits(amount, 18)} ETH`
          : amountText(amount, tokenOf(tokenAddress)) + (tokenOf(tokenAddress) ? "" : ` of ${label(tokenAddress)}`);
        const [chain, account] = recipient.includes(":") ? recipient.split(/:(.*)/s) : ["eth", recipient];
        const destination = chain === "near" ? `NEAR account ${account}` : `${account} on ${chain}`;
        return `bridge ${what} to ${destination} through ${contract(target)} (relayer fee ${formatUnits(nativeFee, 18)} ETH)`;
      }
      if (pool.functionName === "depositETHTo") return `bridge ${formatUnits(value, 18)} ETH through ${contract(target)} to ${label(pool.args[0])}`;
    }
  } catch {
    // fall through
  }
  return `call function ${calldata.slice(0, 10)} on ${contract(target)}${value > 0n ? ` with ${formatUnits(value, 18)} ETH` : ""}`;
}


// ---------------------------------------------------------------------------
// Editing a role: the vault's role -> the draft that compiles to it
// ---------------------------------------------------------------------------

/** A role as the vault holds it: `get_role`, its budgets (`get_allowance`), NEAR and Solana rights. */
export type ChainRole = {
  name: string;
  config: RoleConfig;
  /** Budgets by allowance key (0x hex, lowercase): the refill amount and its period. */
  allowances: Record<string, { refill: string; period_ns: number }>;
  near?: NearPermission[];
  solana?: SolanaPermission[];
  /** The company's shares contract, for a revenue-sharing block. */
  sharesAccountId?: string | null;
};

const ROLE_BLOCK_KINDS = ["payments", "swap", "lending", "wrap", "share-revenue", "solana-transfer", "near-transfer"] as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(typeof value === "string" ? value.toLowerCase() : value);
}

const addressOfWord = (word: Hex): Hex => getAddress(`0x${word.slice(-40)}`);
const wordValue = (word: Hex): bigint => BigInt(word === "0x" ? 0 : word);

/**
 * Rebuilds the draft of a role from what the vault holds, so it can be edited: each budget key
 * names its block (allowanceKey(role, "<kind>-<n>")), and each block's rights are read from the
 * permissions that use it. The draft is returned only when it compiles back to exactly the same
 * role; null means the role was not made by this editor (or differs) and cannot be edited here.
 * Members are not part of it: they come from the memberships.
 */
export function roleDraftFromChain(role: ChainRole, profile: ChainProfile): RoleDraft | null {
  try {
    return decompile(role, profile);
  } catch {
    return null;
  }
}

function decompile(role: ChainRole, profile: ChainProfile): RoleDraft | null {
  const permissions = role.config.permissions;
  const keyOf = (permission: Permission) => permission.conditions.find((condition) => condition.operator === Operator.WithinAllowance)?.compValue.toLowerCase() ?? null;
  const keys = new Set<string>();
  for (const permission of permissions) { const key = keyOf(permission); if (key) keys.add(key); }
  for (const permission of role.near ?? []) keys.add(hexOf(permission.allowance).toLowerCase());
  for (const permission of role.solana ?? []) keys.add(hexOf(permission.allowance).toLowerCase());
  // Each key names its block: kind and position.
  const slots: Array<{ key: string; kind: (typeof ROLE_BLOCK_KINDS)[number]; index: number }> = [];
  for (const key of keys) {
    let found: (typeof slots)[number] | null = null;
    for (let index = 1; index <= 32 && !found; index += 1) {
      for (const kind of ROLE_BLOCK_KINDS) {
        if (hexOf(allowanceKey(role.name, `${kind}-${index}`)).toLowerCase() === key) { found = { key, kind, index }; break; }
      }
    }
    if (!found) return null;
    slots.push(found);
  }
  slots.sort((a, b) => a.index - b.index);
  if (slots.some((slot, position) => slot.index !== position + 1)) return null;

  let suppliersOnly = false;
  const blocks: RoleBlock[] = slots.map((slot): RoleBlock => {
    const allowance = role.allowances[slot.key];
    if (!allowance) throw new Error("budget missing");
    const periodDays = allowance.period_ns / NS_PER_DAY;
    const at = permissions.findIndex((permission) => keyOf(permission) === slot.key);
    const permission = permissions[at];
    const budgetIn = (decimals: number) => ({ amount: formatUnits(BigInt(allowance.refill), decimals), periodDays });
    const words = (items: ConditionFlat[]) => items.filter((condition) => condition.operator === Operator.EqualTo && condition.paramType === Encoding.Static).map((condition) => addressOfWord(condition.compValue));
    const approvalBefore = () => {
      const approve = permissions[at - 1];
      if (!approve || hexOf(approve.selector ?? []).toLowerCase() !== SELECTORS.approve.toLowerCase()) throw new Error("approval missing");
      const limit = approve.conditions.find((condition) => condition.operator === Operator.LessThan);
      return { token: getAddress(hexOf(approve.target)), max: wordValue(limit!.compValue) - 1n };
    };
    switch (slot.kind) {
      case "payments": {
        const token = tokenOf(profile, getAddress(hexOf(permission!.target)));
        if (permission!.conditions.some((condition) => condition.operator === Operator.InAddressList)) {
          suppliersOnly = true;
          return { kind: "payments", token: token.address, recipients: [], budget: budgetIn(token.decimals) };
        }
        return { kind: "payments", token: token.address, recipients: words(permission!.conditions.slice(1)).map((address) => ({ address, label: "" })), budget: budgetIn(token.decimals) };
      }
      case "swap": {
        const { token: tokenIn, max } = approvalBefore();
        const token = tokenOf(profile, tokenIn);
        const sheets = permissions.filter((item) => keyOf(item) === slot.key);
        const protocols = (Object.keys(profile.protocols) as ProtocolId[]).filter((id) => sheets.some((item) => getAddress(hexOf(item.target)) === getAddress(profile.protocols[id].router)));
        const v3 = sheets.find((item) => hexOf(item.selector ?? []).toLowerCase() === SELECTORS.exactInputSingle.toLowerCase());
        const tokensOut = v3
          ? words(v3.conditions.slice(3)).filter((address) => address.toLowerCase() !== tokenIn.toLowerCase())
          : profile.tokens.map((item) => item.address).filter((address) => address.toLowerCase() !== tokenIn.toLowerCase()
            && sheets.some((item) => item.conditions.some((condition) => condition.compValue.toLowerCase() === routeHash([tokenIn, address]).toLowerCase())));
        return { kind: "swap", tokenIn, tokensOut, protocols, budget: budgetIn(token.decimals), maxApproval: formatUnits(max, token.decimals) };
      }
      case "lending": {
        const { token: asset, max } = approvalBefore();
        const token = tokenOf(profile, asset);
        const pool = getAddress(hexOf(permission!.target));
        const protocol = (Object.keys(profile.lending ?? {}) as LendingId[]).find((id) => getAddress(profile.lending![id]!.pool) === pool);
        if (!protocol) throw new Error("unknown pool");
        return { kind: "lending", protocol, token: token.address, budget: budgetIn(token.decimals), maxApproval: formatUnits(max, token.decimals) };
      }
      case "wrap":
        return { kind: "wrap", budget: budgetIn(18) };
      case "share-revenue":
        if (!role.sharesAccountId) throw new Error("shares account unknown");
        return { kind: "share-revenue", sharesAccountId: role.sharesAccountId, budget: budgetIn(18) };
      case "near-transfer": {
        const near = (role.near ?? []).find((item) => hexOf(item.allowance).toLowerCase() === slot.key)!;
        const ft = NEAR_TESTNET_TOKENS.find((item) => item.accountId === near.token);
        if (!ft) throw new Error("unknown NEAR token");
        const budget = budgetIn(ft.decimals);
        const amount = BigInt(allowance.refill);
        const max = BigInt(near.max_per_transfer);
        const floor = amount / NEAR_DEFAULT_TRANSFERS_PER_PERIOD;
        const defaultMin = floor < 1n ? 1n : floor > max ? max : floor;
        return {
          kind: "near-transfer", token: ft.symbol, receivers: near.receivers.map((accountId) => ({ accountId, label: "" })), budget,
          maxPerTransfer: formatUnits(max, ft.decimals),
          ...(BigInt(near.min_per_transfer) === defaultMin ? {} : { minPerTransfer: formatUnits(BigInt(near.min_per_transfer), ft.decimals) }),
        };
      }
      case "solana-transfer": {
        const sol = (role.solana ?? []).find((item) => hexOf(item.allowance).toLowerCase() === slot.key)!;
        const mint = sol.asset === "Sol" ? null : base58Encode(sol.asset.Spl.mint);
        const token = solanaTokenOf(SOLANA_DEVNET, mint);
        return { kind: "solana-transfer", token: token.mint ? token.symbol : null, recipients: sol.recipients.map((address) => ({ address: base58Encode(address), label: "" })), budget: budgetIn(token.decimals) };
      }
    }
  });

  const config = role.config;
  const draft: RoleDraft = {
    name: role.name,
    guardRequired: config.guard_required ?? false,
    suppliersOnly,
    blocks,
    members: [],
    gas: { gas_limit: config.gas_limit, max_fee_per_gas: config.max_fee_per_gas, max_priority_fee_per_gas: config.max_priority_fee_per_gas, max_total_fee: config.max_total_fee },
  };
  // Only what compiles back to the very same role is an edit of it.
  const compiled = compileRole(draft, profile);
  const setRole = compiled.find((change): change is Extract<RuleChange, { SetRole: unknown }> => "SetRole" in change)!;
  if (canonicalJson(setRole.SetRole.config) !== canonicalJson({ ...config, guard_required: config.guard_required ?? false })) return null;
  for (const change of compiled) {
    if ("SetAllowance" in change) {
      const onChain = role.allowances[hexOf(change.SetAllowance.key).toLowerCase()];
      if (!onChain || onChain.refill !== change.SetAllowance.refill || onChain.period_ns !== change.SetAllowance.period_ns) return null;
    }
  }
  const near = compiled.find((change): change is Extract<RuleChange, { SetNearPermissions: unknown }> => "SetNearPermissions" in change)?.SetNearPermissions.permissions ?? [];
  const solana = compiled.find((change): change is Extract<RuleChange, { SetSolanaPermissions: unknown }> => "SetSolanaPermissions" in change)?.SetSolanaPermissions.permissions ?? [];
  if (canonicalJson(near) !== canonicalJson(role.near ?? []) || canonicalJson(solana) !== canonicalJson(role.solana ?? [])) return null;
  return draft;
}

/** The budgets a block keeps when editing: its key, if it still has the same amount and period. */
export function unchangedBudgets(before: RoleDraft, after: RoleDraft, profile: ChainProfile): Hex[] {
  const budgets = (draft: RoleDraft) => new Map(compileRole({ ...draft, members: [], keepBudgets: [], revokeMembers: [] }, profile)
    .filter((change): change is Extract<RuleChange, { SetAllowance: unknown }> => "SetAllowance" in change)
    .map((change) => [hexOf(change.SetAllowance.key).toLowerCase(), `${change.SetAllowance.refill}/${change.SetAllowance.period_ns}`]));
  const old = budgets(before);
  return [...budgets(after)].filter(([key, value]) => old.get(key) === value).map(([key]) => key as Hex);
}
