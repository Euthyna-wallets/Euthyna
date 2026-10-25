/**
 * OmniRoles treasury for the console: DAO + keyless vault + company wallet,
 * governance read from chain, agent dry runs and activity.
 *
 * Trust model: the server pays and submits the deployment, but every result is
 * re-read on chain (`status().checks`): DAO members and threshold, vault code
 * hash, vault without access keys, owner = DAO, Guard keys. Rule changes only
 * happen through DAO proposals signed by members; the server never holds a key
 * that moves funds.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Prisma, PrismaClient } from "@mandateos/db";
import {
  BASE_SEPOLIA,
  budgetsOf,
  compileRole,
  decodeVaultCalls,
  describeCall,
  describeVaultCall,
  describeDaoTransactions,
  chainName,
  type DaoTransactionDraft,
  councilPolicy,
  describePolicyChange,
  describeSharesProposal,
  hasShareholdersRole,
  membersProposalArgs,
  parseNear,
  proposalOf,
  revenueProposalKind,
  sharesInitArgs,
  sharesProposalKinds,
  proposalArgs,
  PROPOSAL_MARKER,
  hexOf,
  type ChainProfile,
  type RoleDraft,
  type RuleChange,
  type VaultCall,
} from "@mandateos/sdk/roles";
import bs58 from "bs58";
import { bytesToHex, erc20Abi, formatUnits, getAddress, keccak256, type Hex, type PublicClient } from "viem";

import { chainClient, estimateCalls, GasEstimateError, rpcUrls, type GasCall } from "./evm-gas.js";
import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { NEAR_ACCOUNT_ID, NEAR_PROVIDER_ID, nearUserEmail } from "./near-auth.js";

export class OmniRolesError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface OmniRolesConfig {
  nearNetwork: string;
  daoFactoryId: string;
  mpcContractId: string;
  artifactsDir: string;
  accountParent: string;
  daoCreateDepositYocto: string;
  vaultDepositYocto: string;
  /** Funds the shares account: contract storage (~2.2 NEAR) and holder registrations. */
  sharesDepositYocto?: string;
  /** NEP-141 token shared as revenue next to NEAR (for example bridged Base ETH). */
  sharesRevenueToken?: string | null;
  baseRpcUrl: string;
  /** RPC per extra EVM chain the company wallet can act on (same address everywhere). */
  extraRpcUrls?: Record<number, string>;
  ruleDelayNs: number;
  ruleExpirationNs: number;
  operationTtlNs: number;
  proposalPeriodNs: string;
  proposalBondYocto: string;
}

export interface OmniRolesChain {
  /** Read ETH and token balances of the company wallet. */
  balances(address: Hex, profile: ChainProfile): Promise<{ eth: string; tokens: Array<{ symbol: string; address: Hex; amount: string }> }>;
  /**
   * Gas limits for calls sent in this order from the wallet on one chain, and
   * fees generous enough to still pass after the vote and the veto window.
   */
  fees(input: { chainId: number; from: Hex; calls: GasCall[] }): Promise<{ gasLimits: bigint[]; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  /** Transactions the wallet has had mined on a chain (its next nonce). */
  nonce(chainId: number, address: Hex): Promise<number>;
  /** The mined result of a transaction, or null while it is not mined. */
  receipt(chainId: number, hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: string } | null>;
}

/** NEAR storage: 1e19 yocto per byte; top the vault up below 0.5 NEAR free. */
const STORAGE_PRICE_PER_BYTE = 10_000_000_000_000_000_000n;
const STORAGE_LOW_YOCTO = 500_000_000_000_000_000_000_000n;
const STORAGE_TOP_UP_YOCTO = 1_000_000_000_000_000_000_000_000n;

/** Lowest max fee a voted transaction gets, per chain (wei). */
const FEE_FLOOR_WEI: Record<number, bigint> = { 1: 20_000_000_000n, 11155111: 5_000_000_000n, 8453: 50_000_000n, 84532: 50_000_000n };

export class RpcOmniRolesChain implements OmniRolesChain {
  private readonly clients = new Map<number, PublicClient>();
  private readonly configured: Record<number, string>;

  constructor(rpcUrl: string, rpcUrls: Record<number, string> = {}) {
    this.configured = { 84532: rpcUrl, ...rpcUrls };
  }

  private client(chainId: number): PublicClient {
    let client = this.clients.get(chainId);
    if (!client) {
      const urls = rpcUrls(chainId, [this.configured[chainId]]);
      if (urls.length === 0) throw new OmniRolesError(400, "unsupported_chain", `no RPC configured for chain ${chainId}`);
      client = chainClient(urls);
      this.clients.set(chainId, client);
    }
    return client;
  }

  async fees(input: { chainId: number; from: Hex; calls: GasCall[] }) {
    const client = this.client(input.chainId);
    let gasLimits: bigint[];
    let gasPrice: bigint;
    try {
      [gasLimits, gasPrice] = await Promise.all([estimateCalls(client, input.from, input.calls), client.getGasPrice()]);
    } catch (error) {
      if (error instanceof GasEstimateError) throw error;
      throw new GasEstimateError("rpc_unavailable", 0, error instanceof Error ? error.message : String(error));
    }
    // Signed after the vote and the veto window: leave room for fees to rise.
    const floor = FEE_FLOOR_WEI[input.chainId] ?? 1_000_000_000n;
    const priority = input.chainId === 11155111 || input.chainId === 1 ? 1_000_000_000n : 1_000_000n;
    const maxFeePerGas = gasPrice * 3n + priority > floor ? gasPrice * 3n + priority : floor;
    return { gasLimits, maxFeePerGas, maxPriorityFeePerGas: priority < maxFeePerGas ? priority : maxFeePerGas };
  }

  async nonce(chainId: number, address: Hex): Promise<number> {
    return this.client(chainId).getTransactionCount({ address, blockTag: "latest" });
  }

  async receipt(chainId: number, hash: Hex) {
    const receipt = await this.client(chainId).getTransactionReceipt({ hash }).catch((error: unknown) => {
      if (error instanceof Error && /could not be found|not found/i.test(error.message)) return null;
      throw error;
    });
    return receipt ? { status: receipt.status, blockNumber: receipt.blockNumber.toString() } : null;
  }

  async balances(address: Hex, profile: ChainProfile) {
    const client = this.client(84532);
    const eth = await client.getBalance({ address });
    const tokens = await Promise.all(profile.tokens.map(async (token) => {
      const amount = await client
        .readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [address] })
        .catch(() => 0n);
      return { symbol: token.symbol, address: token.address, amount: formatUnits(amount, token.decimals) };
    }));
    return { eth: formatUnits(eth, 18), tokens };
  }
}

export type Check = { label: string; ok: boolean; expected: string; actual: string };

type CouncilMember = { memberId: string; nearAccountId: string; name: string | null };

export type OmniRolesPlan = {
  daoAccountId: string;
  vaultAccountId: string;
  council: CouncilMember[];
  threshold: number;
  ruleDelaySeconds: number;
  vaultWasmSha256: string;
};

type QueuedRule = {
  queue_id: number[];
  change: RuleChange;
  proposed_by: string;
  queued_at_ns: string;
  execute_after_ns: string;
  expires_at_ns: string;
  state: "Queued" | "Executed" | "Vetoed" | "Expired";
  vetoed_by: string | null;
};

type DaoOperation = {
  op_id: number[];
  state: string;
  request: { chain_id: number; target: number[]; value: string; calldata: number[]; reference: string; gas_limit: string; max_fee_per_gas: string; max_priority_fee_per_gas: string };
  evm_nonce: number;
  tx_digest: number[];
  execute_after_ns: string | null;
  expires_at_ns: string;
  created_at_ns: string;
  vetoed_by?: string | null;
};

type LedgerOperation = DaoOperation & { member: string; role: string; signed_transaction: number[] | null };

/** Most recent operations the activity page looks up on chain. */
const ACTIVITY_LIMIT = 30;

type SharesInfoView = {
  dao_id: string;
  name: string;
  symbol: string;
  total_supply: string;
  unsold: string;
  price_per_share: string;
  unlock_period_ns: string;
  revenue_token: string | null;
  near_distributed: string;
  token_distributed: string;
};

type SharesHolderView = {
  balance: string;
  locked: string;
  cooling: string;
  cooling_until_ns: string;
  transferable: string;
  claimable_near: string;
  claimable_token: string;
};

export type SharesDraft = {
  name: string;
  symbol: string;
  totalSupply: number;
  priceNear: string;
  allocations: Array<{ accountId: string; shares: number }>;
};

type DaoProposal = {
  id: number;
  proposer: string;
  description: string;
  kind: unknown;
  status: string;
  vote_counts: Record<string, unknown>;
  votes: Record<string, string>;
  submission_time: string;
};

const PROFILE = BASE_SEPOLIA;
/** EVM chains the console offers for DAO transactions. */
const SUPPORTED_CHAINS = [84532, 11155111];
const NANOS_PER_MS = 1_000_000n;

function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "company";
}

function nowNs(): bigint {
  return BigInt(Date.now()) * NANOS_PER_MS;
}

export class OmniRolesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly near: NearClient,
    private readonly visaSigner: KmsSigner,
    private readonly statusSigner: KmsSigner,
    private readonly config: OmniRolesConfig,
    private readonly chain: OmniRolesChain = new RpcOmniRolesChain(config.baseRpcUrl, config.extraRpcUrls),
  ) {}

  // -------------------------------------------------------------------------
  // Treasury creation
  // -------------------------------------------------------------------------

  async plan(organizationId: string, daoName: string): Promise<OmniRolesPlan> {
    const members = await this.prisma.member.findMany({
      where: { organizationId, nearAccountId: { not: null } },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    });
    const council = members
      .filter((member) => member.nearAccountId)
      .map((member) => ({ memberId: member.id, nearAccountId: member.nearAccountId as string, name: member.user.name }));
    if (council.length < 3) {
      throw new OmniRolesError(409, "council_too_small", "at least three members (NEAR accounts) are needed to govern the treasury");
    }
    const slug = slugify(daoName);
    const daoAccountId = `${slug}.${this.config.daoFactoryId}`;
    const vaultAccountId = `${slug.slice(0, 20).replace(/-+$/, "")}-vault.${this.config.accountParent}`;
    for (const accountId of [daoAccountId, vaultAccountId]) {
      if (accountId.length > 64) throw new OmniRolesError(400, "account_id_too_long", `${accountId} is longer than 64 characters`);
    }
    const artifact = await this.artifact();
    return {
      daoAccountId,
      vaultAccountId,
      council,
      threshold: Math.ceil((2 * council.length) / 3),
      ruleDelaySeconds: this.config.ruleDelayNs / 1e9,
      vaultWasmSha256: artifact.sha256,
    };
  }

  // -------------------------------------------------------------------------
  // Members: NEAR accounts entered by an admin before the DAO exists
  // -------------------------------------------------------------------------

  /** The company treasury, for routes that need the vault (agents). */
  async activeTreasury(organizationId: string) {
    const treasury = await this.treasury(organizationId);
    return treasury ? { status: treasury.status, daoAccountId: treasury.daoAccountId, vaultAccountId: treasury.vaultAccountId } : null;
  }

  async members(organizationId: string) {
    const members = await this.prisma.member.findMany({
      where: { organizationId },
      include: { user: { include: { sessions: { select: { id: true }, take: 1 } } } },
      orderBy: { createdAt: "asc" },
    });
    const treasury = await this.treasury(organizationId);
    return {
      locked: Boolean(treasury),
      members: members.map((member) => ({
        id: member.id,
        nearAccountId: member.nearAccountId,
        name: member.user.name === member.nearAccountId ? null : member.user.name,
        role: member.role,
        signedIn: member.user.sessions.length > 0,
      })),
    };
  }

  async addMember(organizationId: string, input: { nearAccountId: string; name?: string | undefined }) {
    if (await this.treasury(organizationId)) {
      throw new OmniRolesError(409, "treasury_exists", "members are fixed in the DAO once the treasury exists");
    }
    const accountId = input.nearAccountId.trim().toLowerCase();
    if (!NEAR_ACCOUNT_ID.test(accountId)) throw new OmniRolesError(400, "invalid_account", `${accountId} is not a NEAR account id`);
    if (!(await this.accountExists(accountId))) {
      throw new OmniRolesError(422, "account_not_found", `${accountId} does not exist on NEAR ${this.config.nearNetwork}`);
    }
    const taken = await this.prisma.member.findFirst({ where: { organizationId, nearAccountId: accountId } });
    if (taken) throw new OmniRolesError(409, "member_exists", `${accountId} is already a member`);
    // The user is the NEAR account: signing in with that wallet later lands on this seat.
    if (!(await this.createSeat(organizationId, accountId, input.name))) {
      throw new OmniRolesError(409, "member_exists", `${accountId} is already a member`);
    }
    return this.members(organizationId);
  }

  async removeMember(organizationId: string, memberId: string, actorMemberId: string) {
    if (await this.treasury(organizationId)) {
      throw new OmniRolesError(409, "treasury_exists", "members are fixed in the DAO once the treasury exists");
    }
    if (memberId === actorMemberId) throw new OmniRolesError(400, "cannot_remove_self", "you cannot remove yourself");
    const member = await this.prisma.member.findFirst({ where: { id: memberId, organizationId } });
    if (!member) throw new OmniRolesError(404, "member_not_found", "member not found");
    if (member.role === "owner") throw new OmniRolesError(400, "cannot_remove_owner", "the company owner cannot be removed");
    await this.prisma.member.delete({ where: { id: memberId } });
    return this.members(organizationId);
  }

  async create(organizationId: string, daoName: string): Promise<{ daoTransaction: string; vaultTransaction: string }> {
    const existing = await this.prisma.treasury.findUnique({
      where: { organizationId_environment: { organizationId, environment: "uat" } },
    });
    if (existing) throw new OmniRolesError(409, "treasury_exists", "this company already has a treasury");
    const plan = await this.plan(organizationId, daoName);
    for (const accountId of [plan.daoAccountId, plan.vaultAccountId]) {
      if (await this.accountExists(accountId)) {
        throw new OmniRolesError(409, "account_taken", `${accountId} already exists; choose another company name`);
      }
    }
    const policy = this.daoPolicy(plan);
    const daoArgs = {
      config: { name: `${daoName} treasury DAO`, purpose: "Set the rules AI agents follow with company funds", metadata: "" },
      policy,
    };
    const daoTransaction = await this.near.callFunction(
      this.config.daoFactoryId,
      "create",
      { name: plan.daoAccountId.split(".")[0], args: Buffer.from(JSON.stringify(daoArgs)).toString("base64") },
      "150000000000000",
      this.config.daoCreateDepositYocto,
    );
    const artifact = await this.artifact();
    const initArgs = {
      client_id: plan.daoAccountId.split(".")[0],
      owner_id: plan.daoAccountId,
      mpc_contract_id: this.config.mpcContractId,
      visa_public_key: Buffer.from(await this.visaSigner.publicKey()).toString("base64"),
      status_public_key: Buffer.from(await this.statusSigner.publicKey()).toString("base64"),
      policy_version: 1,
      registry_version: 1,
      operation_ttl_ns: this.config.operationTtlNs,
      rule_delay_ns: this.config.ruleDelayNs,
      rule_expiration_ns: this.config.ruleExpirationNs,
      council: plan.council.map((member) => member.nearAccountId),
    };
    // No AddKey action: the vault account never has an access key.
    const vaultTransaction = await this.near.executeActions(plan.vaultAccountId, [
      { type: "CreateAccount" },
      { type: "Transfer", depositYocto: this.config.vaultDepositYocto },
      { type: "DeployContract", codeBase64: artifact.base64 },
      { type: "FunctionCall", methodName: "new", args: initArgs, gasTgas: 100 },
    ]);
    await this.prisma.treasury.create({
      data: {
        organizationId,
        environment: "uat",
        nearNetwork: this.config.nearNetwork,
        baseChainId: PROFILE.chainId,
        daoAccountId: plan.daoAccountId,
        vaultAccountId: plan.vaultAccountId,
        vaultWasmSha256: artifact.sha256,
        status: "wallet_pending",
      },
    });
    return { daoTransaction, vaultTransaction };
  }

  private daoPolicy(plan: { council: Array<{ nearAccountId: string }> }, options: { shareholders?: boolean } = {}) {
    return councilPolicy(plan.council.map((member) => member.nearAccountId), {
      proposalBond: this.config.proposalBondYocto,
      proposalPeriodNs: this.config.proposalPeriodNs,
    }, options);
  }

  // -------------------------------------------------------------------------
  // Shares
  // -------------------------------------------------------------------------

  /** One shares contract per company, next to its vault. */
  private sharesAccountOf(treasury: { vaultAccountId: string }): string {
    return treasury.vaultAccountId.replace(/-vault\./, "-shares.");
  }

  async shares(organizationId: string, viewer: string | null) {
    const treasury = await this.requireTreasury(organizationId);
    const accountId = this.sharesAccountOf(treasury);
    if (!(await this.accountExists(accountId))) return { accountId, deployed: false as const };
    const [info, keys, staking, policy, lockedTotal] = await Promise.all([
      this.view<SharesInfoView>(accountId, "info"),
      this.cached("keys", accountId),
      this.view<string>(treasury.daoAccountId, "get_staking_contract"),
      this.view<{ roles: Parameters<typeof hasShareholdersRole>[0]["roles"] }>(treasury.daoAccountId, "get_policy"),
      this.view<string>(treasury.daoAccountId, "delegation_total_supply").catch(() => "0"),
    ]);
    if (info.dao_id !== treasury.daoAccountId) {
      throw new OmniRolesError(409, "shares_foreign", `${accountId} belongs to ${info.dao_id}, not to this company`);
    }
    const me = viewer
      ? {
        accountId: viewer,
        holder: await this.view<SharesHolderView | null>(accountId, "holder_of", { account_id: viewer }),
        votes: await this.view<string>(treasury.daoAccountId, "delegation_balance_of", { account_id: viewer }).catch(() => "0"),
      }
      : null;
    const revenueToken = info.revenue_token
      ? await this.view<{ symbol: string; decimals: number }>(info.revenue_token, "ft_metadata")
        .then((metadata) => ({ accountId: info.revenue_token!, symbol: metadata.symbol, decimals: metadata.decimals }))
        .catch(() => ({ accountId: info.revenue_token!, symbol: info.revenue_token!, decimals: 0 }))
      : null;
    return {
      accountId,
      deployed: true as const,
      keyless: keys.keys.length === 0,
      revenueToken,
      daoAccountId: treasury.daoAccountId,
      info,
      votesCounted: staking === accountId,
      shareholdersVote: hasShareholdersRole(policy),
      lockedTotal,
      me,
    };
  }

  /**
   * Deploys the shares contract on an account with no access key, then returns
   * the two votes that turn it on. Nothing changes for the company until the
   * members approve them.
   */
  async createShares(organizationId: string, input: SharesDraft) {
    const treasury = await this.requireTreasury(organizationId);
    const accountId = this.sharesAccountOf(treasury);
    if (await this.accountExists(accountId)) throw new OmniRolesError(409, "shares_exist", `${accountId} already exists`);
    let initArgs: ReturnType<typeof sharesInitArgs>;
    try {
      initArgs = sharesInitArgs(treasury.daoAccountId, {
        name: input.name,
        symbol: input.symbol,
        totalSupply: input.totalSupply,
        pricePerShareYocto: parseNear(input.priceNear),
        // Longer than a proposal: unlocked shares cannot vote twice on one proposal.
        unlockPeriodNs: (BigInt(this.config.proposalPeriodNs) * 2n).toString(),
        revenueToken: this.config.sharesRevenueToken ?? null,
        allocations: input.allocations.map((allocation) => [allocation.accountId, allocation.shares]),
      });
    } catch (error) {
      throw new OmniRolesError(400, "invalid_shares", error instanceof Error ? error.message : String(error));
    }
    for (const allocation of input.allocations) {
      if (!(await this.accountExists(allocation.accountId))) {
        throw new OmniRolesError(422, "account_not_found", `${allocation.accountId} does not exist on NEAR ${this.config.nearNetwork}`);
      }
    }
    const artifact = await this.artifact("shares.wasm");
    // No AddKey action: nobody can sign for the shares account.
    const transaction = await this.near.executeActions(accountId, [
      { type: "CreateAccount" },
      { type: "Transfer", depositYocto: this.config.sharesDepositYocto ?? "2600000000000000000000000" },
      { type: "DeployContract", codeBase64: artifact.base64 },
      { type: "FunctionCall", methodName: "new", args: initArgs, gasTgas: 50 },
    ]);
    this.forget(accountId);
    return { accountId, transaction, wasmSha256: artifact.sha256, ...(await this.sharesProposals(organizationId)) };
  }

  /** The votes still missing to turn shares on. */
  async sharesProposals(organizationId: string) {
    const treasury = await this.requireTreasury(organizationId);
    const accountId = this.sharesAccountOf(treasury);
    const [staking, policy] = await Promise.all([
      this.near.viewFunction<string>(treasury.daoAccountId, "get_staking_contract", {}),
      this.near.viewFunction<{ roles: Parameters<typeof hasShareholdersRole>[0]["roles"] }>(treasury.daoAccountId, "get_policy", {}),
    ]);
    const [stakingVote, roleVote] = sharesProposalKinds(accountId);
    const missing = [
      ...(staking ? [] : [stakingVote!]),
      ...(hasShareholdersRole(policy) ? [] : [roleVote!]),
    ];
    if (staking && staking !== accountId) {
      throw new OmniRolesError(409, "staking_taken", `the DAO already counts votes from ${staking}`);
    }
    return { proposals: missing.map((vote) => this.daoProposal(treasury, vote.title, vote.kind, accountId)) };
  }

  /** Share NEAR from the DAO account with every shareholder. */
  async revenueProposal(organizationId: string, amountNear: string) {
    const treasury = await this.requireTreasury(organizationId);
    const accountId = this.sharesAccountOf(treasury);
    let amount: string;
    try {
      amount = parseNear(amountNear);
    } catch (error) {
      throw new OmniRolesError(400, "invalid_amount", error instanceof Error ? error.message : String(error));
    }
    if (BigInt(amount) === 0n) throw new OmniRolesError(400, "invalid_amount", "the amount must be above zero");
    const info = await this.view<SharesInfoView>(accountId, "info").catch(() => null);
    if (!info) throw new OmniRolesError(409, "shares_missing", "this company has no shares yet");
    const kind = revenueProposalKind(accountId, amount);
    return this.daoProposal(treasury, describeSharesProposal(kind, accountId)!.title, kind, accountId);
  }

  private daoProposal(treasury: { daoAccountId: string }, title: string, kind: unknown, sharesAccountId: string) {
    return {
      receiverId: treasury.daoAccountId,
      args: proposalOf(title, kind),
      deposit: this.config.proposalBondYocto,
      title,
      summary: [describeSharesProposal(kind, sharesAccountId) ?? { title, details: [] }],
    };
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  async status(organizationId: string) {
    const treasury = await this.treasury(organizationId);
    if (!treasury) return { treasury: null, checks: [], wallet: null, dao: null, paused: false };
    const [daoPolicy, daoKeys, vaultAccount, vaultKeys, owner, council, visa, status, wallet, paused] = await Promise.all([
      this.view<{ roles: Array<{ name: string; kind: unknown }>; default_vote_policy: { threshold: unknown } }>(treasury.daoAccountId, "get_policy").catch(() => null),
      this.cached("keys", treasury.daoAccountId).catch(() => null),
      this.cached("account", treasury.vaultAccountId).catch(() => null),
      this.cached("keys", treasury.vaultAccountId).catch(() => null),
      this.view<string>(treasury.vaultAccountId, "owner_id").catch(() => null),
      this.view<string[]>(treasury.vaultAccountId, "council").catch(() => null),
      this.view<string>(treasury.vaultAccountId, "visa_public_key").catch(() => null),
      this.view<string>(treasury.vaultAccountId, "status_public_key").catch(() => null),
      this.view<{ address: number[] | null } | null>(treasury.vaultAccountId, "get_wallet", { chain_id: treasury.baseChainId }).catch(() => null),
      this.view<boolean>(treasury.vaultAccountId, "is_paused").catch(() => false),
    ]);
    const daoMembers = (daoPolicy?.roles ?? [])
      .flatMap((role) => ((role.kind as { Group?: string[] })?.Group ?? []))
      .sort();
    if (daoMembers.length) await this.syncSeats(organizationId, daoMembers).catch(() => undefined);
    const plan = await this.plan(organizationId, treasury.daoAccountId.split(".")[0] ?? "company").catch(() => null);
    const expectedMembers = (plan?.council.map((member) => member.nearAccountId) ?? []).sort();
    const expectedCodeHash = bs58.encode(Buffer.from(treasury.vaultWasmSha256, "hex"));
    const visaKey = Buffer.from(await this.visaSigner.publicKey()).toString("base64");
    const statusKey = Buffer.from(await this.statusSigner.publicKey()).toString("base64");
    const check = (label: string, expected: unknown, actual: unknown): Check => ({
      label,
      expected: String(expected),
      actual: String(actual),
      ok: String(expected) === String(actual),
    });
    const checks: Check[] = [
      check("DAO members are the company members", expectedMembers.join(", "), daoMembers.join(", ")),
      check("DAO has no access key (only votes change it)", 0, daoKeys?.keys.length ?? "unreadable"),
      check("Vault code is the published MandateOS vault", expectedCodeHash, vaultAccount?.code_hash ?? "missing"),
      check("Vault has no access key (no one can replace its code)", 0, vaultKeys?.keys.length ?? "unreadable"),
      check("Vault is owned by the DAO", treasury.daoAccountId, owner ?? "unreadable"),
      check("Security council is the DAO members", expectedMembers.join(", "), [...(council ?? [])].sort().join(", ")),
      check("Guard visa key", visaKey, visa ?? "unreadable"),
      check("Guard status key", statusKey, status ?? "unreadable"),
    ];
    const walletAddress = wallet?.address ? getAddress(hexOf(wallet.address)) : null;
    if (walletAddress && treasury.status === "wallet_pending" && checks.every((item) => item.ok)) {
      await this.prisma.treasury.update({ where: { id: treasury.id }, data: { status: "active" } });
      treasury.status = "active";
    }
    return {
      treasury: {
        daoAccountId: treasury.daoAccountId,
        vaultAccountId: treasury.vaultAccountId,
        chainId: treasury.baseChainId,
        chainName: PROFILE.name,
        status: treasury.status,
      },
      checks,
      dao: { members: daoMembers, threshold: daoPolicy?.default_vote_policy.threshold ?? null },
      // The same address on every EVM chain; a chain is usable once its wallet is requested.
      chains: await Promise.all(SUPPORTED_CHAINS.map(async (chainId) => {
        const chainWallet = chainId === treasury.baseChainId
          ? wallet
          : await this.view<{ address: number[] | null } | null>(treasury.vaultAccountId, "get_wallet", { chain_id: chainId }).catch(() => null);
        return { chainId, name: chainName(chainId), enabled: Boolean(chainWallet?.address) };
      })),
      wallet: walletAddress
        ? { address: walletAddress, ...(await this.chain.balances(walletAddress, PROFILE).catch(() => ({ eth: "?", tokens: [] }))) }
        : null,
      paused: Boolean(paused),
    };
  }

  // -------------------------------------------------------------------------
  // Proposals (signed by members in their wallet)
  // -------------------------------------------------------------------------

  async walletProposal(organizationId: string, chainId?: number) {
    const treasury = await this.requireTreasury(organizationId);
    const target = chainId ?? treasury.baseChainId;
    const calls: VaultCall[] = [{ method: "request_wallet", chainId: target }];
    return this.proposal(treasury, `Create the company wallet on ${chainName(target)}`, calls);
  }

  /**
   * A transaction outside any role (from a dApp through WalletConnect, or typed
   * by a member): the DAO votes on the exact calls, which run after the veto window.
   */
  async transactionProposal(
    organizationId: string,
    input: { title?: string | undefined; transactions: Array<{ chainId: number; to: string; value?: string | undefined; data?: string | undefined; gas?: string | undefined }> },
  ) {
    const treasury = await this.requireTreasury(organizationId);
    if (input.transactions.length === 0 || input.transactions.length > 10) {
      throw new OmniRolesError(400, "invalid_transactions", "between 1 and 10 transactions per proposal");
    }
    // Calls of one chain run in order from the same wallet: estimate them together.
    const byChain = new Map<number, Array<{ index: number; to: Hex; value: bigint; data: Hex; gas?: bigint | undefined }>>();
    input.transactions.forEach((transaction, index) => {
      const calls = byChain.get(transaction.chainId) ?? [];
      calls.push({
        index,
        to: getAddress(transaction.to),
        value: BigInt(transaction.value ?? "0"),
        data: (transaction.data && transaction.data !== "0x" ? transaction.data : "0x") as Hex,
        gas: transaction.gas ? BigInt(transaction.gas) : undefined,
      });
      byChain.set(transaction.chainId, calls);
    });
    const drafts: DaoTransactionDraft[] = new Array(input.transactions.length);
    for (const [chainId, calls] of byChain) {
      const wallet = await this.view<{ address: number[] | null } | null>(treasury.vaultAccountId, "get_wallet", { chain_id: chainId }).catch(() => null);
      if (!wallet?.address) {
        throw new OmniRolesError(409, "wallet_missing", `the company wallet is not created on ${chainName(chainId)} yet: propose it first`);
      }
      const from = getAddress(hexOf(wallet.address));
      let fees;
      try {
        fees = await this.chain.fees({ chainId, from, calls });
      } catch (error) {
        if (!(error instanceof GasEstimateError)) throw error;
        const position = input.transactions.length > 1 ? `transaction ${calls[error.index]!.index + 1}` : "the transaction";
        if (error.code === "would_revert") {
          throw new OmniRolesError(422, "would_revert", `${position} would fail on ${chainName(chainId)}: ${error.message}`);
        }
        throw new OmniRolesError(503, "gas_estimate_unavailable", `no ${chainName(chainId)} RPC could estimate ${position}; try again: ${error.message}`);
      }
      calls.forEach((call, position) => {
        drafts[call.index] = {
          chainId,
          to: call.to,
          value: call.value.toString(),
          data: call.data,
          gasLimit: fees.gasLimits[position]!.toString(),
          maxFeePerGas: fees.maxFeePerGas.toString(),
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
        };
      });
    }
    const title = input.title?.trim() || describeDaoTransactions(drafts, { profile: PROFILE }).title;
    return this.proposal(treasury, title, [{ method: "submit_transactions", transactions: drafts }], await this.labels(organizationId));
  }

  async roleProposal(organizationId: string, draft: RoleDraft) {
    const treasury = await this.requireTreasury(organizationId);
    let changes: RuleChange[];
    try {
      changes = compileRole(draft, PROFILE);
    } catch (error) {
      throw new OmniRolesError(400, "invalid_role", error instanceof Error ? error.message : String(error));
    }
    const calls = changes.map((change) => ({ method: "queue_rule_change" as const, change }));
    return this.proposal(treasury, `Set role ${draft.name}`, calls, await this.labels(organizationId));
  }

  async membershipProposal(
    organizationId: string,
    input: { role: string; member: string; kind: "Agent" | "Human"; action: "grant" | "revoke"; maxUses?: number | null },
  ) {
    const treasury = await this.requireTreasury(organizationId);
    const change: RuleChange = input.action === "grant"
      ? { GrantMembership: { role: input.role, member: input.member, kind: input.kind, starts_at_ns: "0", ends_at_ns: null, max_uses: input.maxUses ?? null } }
      : { RevokeMembership: { role: input.role, member: input.member } };
    const title = input.action === "grant" ? `Add ${input.member} to role ${input.role}` : `Remove ${input.member} from role ${input.role}`;
    return this.proposal(treasury, title, [{ method: "queue_rule_change", change }]);
  }

  async pauseProposal(organizationId: string, pause: boolean) {
    const treasury = await this.requireTreasury(organizationId);
    return this.proposal(treasury, pause ? "Pause all operations" : "Resume operations", [{ method: pause ? "pause" : "unpause" }]);
  }

  /**
   * Change who votes. Two proposals, voted together: the DAO policy (members
   * and the two-thirds threshold, applies on approval) and the vault's security
   * council (who can veto and pause, applies after the veto window).
   */
  async membersProposals(organizationId: string, nextMembers: string[]) {
    const treasury = await this.requireTreasury(organizationId);
    const members = nextMembers.map((member) => member.trim().toLowerCase());
    for (const accountId of members) {
      if (!NEAR_ACCOUNT_ID.test(accountId)) throw new OmniRolesError(400, "invalid_account", `${accountId} is not a NEAR account id`);
      if (!(await this.accountExists(accountId))) throw new OmniRolesError(422, "account_not_found", `${accountId} does not exist on NEAR ${this.config.nearNetwork}`);
    }
    let policy: ReturnType<typeof councilPolicy>;
    const current = await this.near.viewFunction<{ roles: Parameters<typeof hasShareholdersRole>[0]["roles"] }>(treasury.daoAccountId, "get_policy", {});
    try {
      policy = this.daoPolicy({ council: members.map((nearAccountId) => ({ nearAccountId })) }, { shareholders: hasShareholdersRole(current) });
    } catch (error) {
      throw new OmniRolesError(400, "invalid_members", error instanceof Error ? error.message : String(error));
    }
    const title = `Change members: ${members.join(", ")}`;
    const policyDraft = {
      receiverId: treasury.daoAccountId,
      args: membersProposalArgs(policy, title),
      deposit: this.config.proposalBondYocto,
      title,
      summary: [describePolicyChange({ ChangePolicy: { policy } })!].map(({ title: heading, details }) => ({ title: heading, details })),
    };
    const councilDraft = await this.proposal(treasury, "Update the security council", [
      { method: "queue_rule_change", change: { SetCouncil: { members } } },
    ]);
    return { proposals: [policyDraft, councilDraft] };
  }

  /** Console seats follow the DAO: every DAO member has one, removed members lose theirs. */
  private async syncSeats(organizationId: string, daoMembers: string[]) {
    const seats = await this.prisma.member.findMany({ where: { organizationId } });
    for (const accountId of daoMembers) {
      if (!seats.some((seat) => seat.nearAccountId === accountId)) await this.createSeat(organizationId, accountId);
    }
    const stale = seats.filter((seat) => seat.role !== "owner" && seat.nearAccountId && !daoMembers.includes(seat.nearAccountId));
    if (stale.length) await this.prisma.member.deleteMany({ where: { id: { in: stale.map((seat) => seat.id) } } });
  }

  private async createSeat(organizationId: string, accountId: string, name?: string) {
    const email = nearUserEmail(accountId);
    const linked = await this.prisma.account.findFirst({ where: { providerId: NEAR_PROVIDER_ID, accountId } });
    const user = linked
      ? await this.prisma.user.findUniqueOrThrow({ where: { id: linked.userId } })
      : (await this.prisma.user.findUnique({ where: { email } })) ?? await this.prisma.user.create({
        data: { id: randomUUID(), name: name?.trim() || accountId, email, emailVerified: true },
      });
    if (!linked) {
      await this.prisma.account.create({
        data: { id: randomUUID(), userId: user.id, providerId: NEAR_PROVIDER_ID, accountId, createdAt: new Date(), updatedAt: new Date() },
      });
    }
    const existingSeat = await this.prisma.member.findFirst({ where: { organizationId, userId: user.id } });
    if (existingSeat) {
      if (!existingSeat.nearAccountId) await this.prisma.member.update({ where: { id: existingSeat.id }, data: { nearAccountId: accountId } });
      return false;
    }
    await this.prisma.member.create({
      data: { id: randomUUID(), organizationId, userId: user.id, role: "member", nearAccountId: accountId, createdAt: new Date() },
    });
    return true;
  }

  private async proposal(
    treasury: { daoAccountId: string; vaultAccountId: string },
    title: string,
    calls: VaultCall[],
    labels: Record<string, string> = {},
  ) {
    const args = proposalArgs(treasury.vaultAccountId, title, calls);
    const changes = calls.flatMap((call) => (call.method === "queue_rule_change" ? [call.change] : []));
    const context = { profile: PROFILE, labels, budgets: budgetsOf(changes, PROFILE) };
    return {
      receiverId: treasury.daoAccountId,
      args,
      deposit: this.config.proposalBondYocto,
      title,
      summary: calls.map((call) => describeVaultCall(call, context)),
    };
  }

  // -------------------------------------------------------------------------
  // Governance view
  // -------------------------------------------------------------------------

  async governance(organizationId: string) {
    const treasury = await this.requireTreasury(organizationId);
    const labels = await this.labels(organizationId);
    const [lastId, policy, rules, paused, daoTransactions, lockedShares] = await Promise.all([
      this.view<number>(treasury.daoAccountId, "get_last_proposal_id"),
      this.view<{ default_vote_policy: { threshold: unknown }; roles: Array<{ kind: unknown }>; proposal_period: string }>(treasury.daoAccountId, "get_policy"),
      this.view<QueuedRule[]>(treasury.vaultAccountId, "list_rule_changes", { before: null, limit: 50 }),
      this.view<boolean>(treasury.vaultAccountId, "is_paused"),
      this.view<DaoOperation[]>(treasury.vaultAccountId, "list_dao_transactions", { limit: 50 }).catch(() => [] as DaoOperation[]),
      this.view<string>(treasury.daoAccountId, "delegation_total_supply").catch(() => "0"),
    ]);
    const proposals = lastId === 0
      ? []
      : await this.view<DaoProposal[]>(treasury.daoAccountId, "get_proposals", { from_index: Math.max(0, lastId - 50), limit: 50 });
    const members = policy.roles.flatMap((role) => ((role.kind as { Group?: string[] })?.Group ?? []));
    await this.syncSeats(organizationId, members);
    // Budgets are named from every role ever proposed, so older budgets keep their names.
    const allChanges = [
      ...rules.map((rule) => rule.change),
      ...proposals.flatMap((proposal) => (decodeVaultCalls(proposal.kind, treasury.vaultAccountId) ?? [])
        .flatMap((call) => (call.method === "queue_rule_change" ? [call.change] : []))),
    ];
    const context = { profile: PROFILE, labels, budgets: budgetsOf(allChanges, PROFILE) };
    const now = nowNs();
    return {
      dao: {
        accountId: treasury.daoAccountId,
        members,
        threshold: policy.default_vote_policy.threshold,
        proposalPeriodNs: policy.proposal_period,
        shareholders: hasShareholdersRole(policy as unknown as Parameters<typeof hasShareholdersRole>[0]) ? { lockedShares } : null,
      },
      vaultAccountId: treasury.vaultAccountId,
      paused,
      proposals: proposals
        .slice()
        .reverse()
        .map((proposal) => {
          const calls = (() => {
            try {
              return decodeVaultCalls(proposal.kind, treasury.vaultAccountId);
            } catch {
              return null;
            }
          })();
          return {
            id: proposal.id,
            title: proposal.description.replace(PROPOSAL_MARKER, "").trim(),
            fromConsole: proposal.description.startsWith(PROPOSAL_MARKER),
            proposer: proposal.proposer,
            status: proposal.status,
            votes: proposal.votes,
            voteCounts: proposal.vote_counts,
            kind: proposal.kind,
            submittedAt: new Date(Number(BigInt(proposal.submission_time) / NANOS_PER_MS)).toISOString(),
            expiresAt: new Date(Number((BigInt(proposal.submission_time) + BigInt(policy.proposal_period)) / NANOS_PER_MS)).toISOString(),
            changes: calls
              ? calls.map((call) => describeVaultCall(call, context))
              : (() => {
                const policyChange = describePolicyChange(proposal.kind);
                const sharesChange = describeSharesProposal(proposal.kind, this.sharesAccountOf(treasury));
                return policyChange
                  ? [{ title: policyChange.title, details: policyChange.details }]
                  : sharesChange
                    ? [sharesChange]
                    : [{ title: "Not a vault change", details: [JSON.stringify(proposal.kind).slice(0, 300)] }];
              })(),
          };
        }),
      rules: rules.map((rule) => ({
        queueId: hexOf(rule.queue_id),
        state: rule.state,
        readyToActivate: rule.state === "Queued" && BigInt(rule.execute_after_ns) <= now && now <= BigInt(rule.expires_at_ns),
        queuedAt: new Date(Number(BigInt(rule.queued_at_ns) / NANOS_PER_MS)).toISOString(),
        activatesAt: new Date(Number(BigInt(rule.execute_after_ns) / NANOS_PER_MS)).toISOString(),
        expiresAt: new Date(Number(BigInt(rule.expires_at_ns) / NANOS_PER_MS)).toISOString(),
        vetoedBy: rule.vetoed_by,
        ...describeVaultCall({ method: "queue_rule_change", change: rule.change }, context),
      })),
      // Transactions voted outside any role: veto window, then signed in order.
      transactions: daoTransactions.map((item) => ({
        opId: hexOf(item.op_id),
        state: item.state,
        createdAt: new Date(Number(BigInt(item.created_at_ns) / NANOS_PER_MS)).toISOString(),
        executesAt: item.execute_after_ns ? new Date(Number(BigInt(item.execute_after_ns) / NANOS_PER_MS)).toISOString() : null,
        ...describeDaoTransactions([{
          chainId: item.request.chain_id,
          to: getAddress(hexOf(item.request.target)),
          value: item.request.value,
          data: hexOf(item.request.calldata),
          gasLimit: item.request.gas_limit,
          maxFeePerGas: item.request.max_fee_per_gas,
          maxPriorityFeePerGas: item.request.max_priority_fee_per_gas,
        }], { ...context, fullAddresses: true }),
      })),
    };
  }

  /** Activate rule changes whose delay has passed (permissionless on chain; MandateOS pays the gas). */
  async activateReadyRules(organizationId: string): Promise<string[]> {
    const treasury = await this.requireTreasury(organizationId);
    await this.keepStorageFunded(treasury.vaultAccountId);
    const rules = await this.view<QueuedRule[]>(treasury.vaultAccountId, "list_rule_changes", { before: null, limit: 50 });
    const now = nowNs();
    const ready = rules
      .filter((rule) => rule.state === "Queued" && BigInt(rule.execute_after_ns) <= now && now <= BigInt(rule.expires_at_ns))
      // Oldest first: a role must exist before its memberships.
      .reverse();
    const hashes: string[] = [];
    for (const rule of ready) {
      hashes.push(await this.near.callFunction(treasury.vaultAccountId, "execute_rule_change", { queue_id: rule.queue_id }, "100000000000000", "0"));
    }
    hashes.push(...await this.startDaoTransactions(organizationId, treasury));
    if (hashes.length) this.forget(treasury.vaultAccountId);
    return hashes;
  }

  /**
   * Every operation the vault keeps (and every MPC signature it stores) costs
   * NEAR storage. When the vault runs short, the MPC callback cannot store the
   * signature and the operation sticks: top it up from the relayer first.
   * Only NEAR for storage moves here, never company funds.
   */
  private async keepStorageFunded(vaultAccountId: string): Promise<void> {
    const account = await this.near.getAccount(vaultAccountId).catch(() => null);
    if (!account) return;
    const free = BigInt(account.amount) - BigInt(account.storage_usage ?? 0) * STORAGE_PRICE_PER_BYTE;
    if (free >= STORAGE_LOW_YOCTO) return;
    await this.near.executeActions(vaultAccountId, [{ type: "Transfer", depositYocto: STORAGE_TOP_UP_YOCTO.toString() }]);
    console.log(JSON.stringify({ event: "omniroles.vault_storage_topped_up", vaultAccountId, freeYocto: free.toString() }));
  }

  /**
   * Start the next voted transaction of each chain once its veto window has
   * passed and the wallet is free (permissionless on chain), then hand every
   * started one to the worker, which broadcasts it like an agent operation.
   */
  private async startDaoTransactions(organizationId: string, treasury: { vaultAccountId: string }): Promise<string[]> {
    const transactions = await this.near.viewFunction<DaoOperation[]>(treasury.vaultAccountId, "list_dao_transactions", { limit: 50 }).catch(() => null);
    if (!transactions) return []; // vault deployed before DAO transactions
    const hashes: string[] = [];
    // The start transaction carries the MPC response: the worker recovers the
    // signature from it if the vault could not store it.
    const startedBy = new Map<number, string>();
    const now = nowNs();
    const busy = new Set(transactions.filter((item) => ["Prepared", "Queued", "PossiblySigned"].includes(item.state)).map((item) => item.request.chain_id));
    const waiting = transactions
      .filter((item) => item.state === "Scheduled" && item.execute_after_ns !== null && BigInt(item.execute_after_ns) <= now && now <= BigInt(item.expires_at_ns))
      .reverse();
    for (const item of waiting) {
      const chainId = item.request.chain_id;
      if (busy.has(chainId)) continue;
      busy.add(chainId);
      const hash = await this.near.callFunction(treasury.vaultAccountId, "start_dao_transaction", { chain_id: chainId }, "150000000000000", "0");
      hashes.push(hash);
      startedBy.set(chainId, hash);
    }
    const started = hashes.length
      ? await this.near.viewFunction<DaoOperation[]>(treasury.vaultAccountId, "list_dao_transactions", { limit: 50 })
      : transactions;
    for (const item of started.filter((entry) => entry.state !== "Scheduled")) {
      const opId = hexOf(item.op_id);
      const existing = await this.prisma.operation.findUnique({ where: { organizationId_opId: { organizationId, opId } } });
      if (existing) continue;
      await this.prisma.operation.create({
        data: {
          organizationId,
          opId,
          agentId: null,
          vaultAccountId: treasury.vaultAccountId,
          reference: item.request.reference,
          state: item.state,
          txDigest: hexOf(item.tx_digest),
          evmNonce: BigInt(item.evm_nonce),
          amount: "0",
          nearAuthorizationTxHash: item.state === "PossiblySigned" || item.state === "Queued" ? startedBy.get(item.request.chain_id) ?? null : null,
          nextAttemptAt: new Date(),
        },
      });
    }
    return hashes;
  }

  async activateAllReadyRules(): Promise<void> {
    const treasuries = await this.prisma.treasury.findMany();
    for (const treasury of treasuries) {
      await this.activateReadyRules(treasury.organizationId).catch((error: unknown) => {
        console.error(`rule activation failed for ${treasury.vaultAccountId}:`, error);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Roles, agents' dry runs and activity
  // -------------------------------------------------------------------------

  async roles(organizationId: string) {
    const treasury = await this.requireTreasury(organizationId);
    const labels = await this.labels(organizationId);
    const rules = await this.view<QueuedRule[]>(treasury.vaultAccountId, "list_rule_changes", { before: null, limit: 50 });
    const executed = rules.filter((rule) => rule.state === "Executed").reverse().map((rule) => rule.change);
    const budgets = budgetsOf(executed, PROFILE);
    const context = { profile: PROFILE, labels, budgets };
    const roleNames = new Set<string>();
    for (const change of executed) {
      if ("SetRole" in change) roleNames.add(change.SetRole.role);
      if ("RemoveRole" in change) roleNames.delete(change.RemoveRole.role);
    }
    const memberships = new Map<string, { member: string; kind: string }[]>();
    for (const change of executed) {
      if ("GrantMembership" in change) {
        const list = (memberships.get(change.GrantMembership.role) ?? []).filter((item) => item.member !== change.GrantMembership.member);
        memberships.set(change.GrantMembership.role, [...list, { member: change.GrantMembership.member, kind: change.GrantMembership.kind }]);
      }
      if ("RevokeMembership" in change) {
        memberships.set(change.RevokeMembership.role, (memberships.get(change.RevokeMembership.role) ?? []).filter((item) => item.member !== change.RevokeMembership.member));
      }
    }
    const roles = await Promise.all([...roleNames].map(async (name) => {
      const view = await this.view<{ config: { enabled: boolean } } | null>(treasury.vaultAccountId, "get_role", { role: name });
      const setRole = [...executed].reverse().find((change) => "SetRole" in change && change.SetRole.role === name) as Extract<RuleChange, { SetRole: unknown }> | undefined;
      const description = setRole ? describeVaultCall({ method: "queue_rule_change", change: setRole }, context) : null;
      const keys = new Set<string>();
      for (const permission of setRole?.SetRole.config.permissions ?? []) {
        for (const condition of permission.conditions) {
          if (condition.operator === 28 || condition.operator === 30) keys.add(condition.compValue.toLowerCase());
        }
      }
      const budgetsView = await Promise.all([...keys].map(async (key) => {
        const allowance = await this.view<{ balance: string; reserved: string; max_refill: string; period_ns: number } | null>(
          treasury.vaultAccountId,
          "get_allowance",
          { key: Array.from(Buffer.from(key.slice(2), "hex")) },
        );
        const info = budgets[key];
        const decimals = info?.token?.decimals ?? 0;
        return {
          key,
          label: info?.label ?? key.slice(0, 10),
          token: info?.token?.symbol ?? null,
          available: allowance ? formatUnits(BigInt(allowance.balance) - BigInt(allowance.reserved), decimals) : null,
          max: allowance ? formatUnits(BigInt(allowance.max_refill), decimals) : null,
          periodDays: allowance ? allowance.period_ns / 86_400_000_000_000 : null,
        };
      }));
      return {
        name,
        enabled: view?.config.enabled ?? false,
        description,
        budgets: budgetsView,
        members: memberships.get(name) ?? [],
      };
    }));
    return { roles };
  }

  /**
   * Dry run for an agent: the vault's verdict (on chain), then, when the role
   * allows it, the Guard's (suppliers, reused references). Nothing is reserved.
   */
  async checkOperation(
    organizationId: string,
    agent: { agentId: string; nearAccountId: string; role: string },
    request: Record<string, unknown>,
    guard?: () => Promise<{ code: string; reasons: string[] } | null>,
  ) {
    const treasury = await this.requireTreasury(organizationId);
    // Never cached: an agent must see the vault's current budgets and rules.
    const vault = await this.near.viewFunction<{ allowed: boolean; reason: string | null; requires_delay: boolean; requires_cosign: boolean; wallet_busy?: boolean }>(
      treasury.vaultAccountId,
      "check_operation",
      { role: agent.role, member: agent.nearAccountId, request },
    );
    const refusedByGuard = vault.allowed && guard ? await guard() : null;
    const result = {
      ...vault,
      allowed: vault.allowed && !refusedByGuard,
      reason: refusedByGuard ? `GUARD:${refusedByGuard.code}:${refusedByGuard.reasons.join("; ")}` : vault.reason,
      refusedBy: refusedByGuard ? "guard" as const : vault.allowed ? null : "vault" as const,
    };
    {
      // Both outcomes are logged: the activity page shows what agents asked for, allowed or not.
      await this.prisma.auditLog.create({
        data: {
          organizationId,
          actorType: "agent",
          actorId: agent.agentId,
          action: result.allowed ? "operation.allowed" : "operation.refused",
          targetType: "operation",
          targetId: typeof request.reference === "string" ? request.reference : null,
          metadata: {
            reason: result.reason,
            role: agent.role,
            target: Array.isArray(request.target) ? getAddress(hexOf(request.target as number[])) : null,
            value: String(request.value ?? "0"),
            calldata: Array.isArray(request.calldata) ? hexOf((request.calldata as number[]).slice(0, 2048)) : null,
          } as Prisma.InputJsonValue,
        },
      });
    }
    return { ...result, explanation: result.allowed ? null : explainRefusal(result.reason ?? "") };
  }

  /** What an agent may do: its role, what is left of its budgets, and the company wallet. */
  async agentMandate(organizationId: string, agent: { nearAccountId: string; role: string }) {
    const treasury = await this.requireTreasury(organizationId);
    const { roles } = await this.roles(organizationId);
    const role = roles.find((item) => item.name === agent.role) ?? null;
    const wallet = await this.view<{ address: number[] | null } | null>(treasury.vaultAccountId, "get_wallet", { chain_id: PROFILE.chainId }).catch(() => null);
    const membership = await this.near.viewFunction<{ active: boolean; max_uses: number | null; used_uses: number; ends_at_ns: string | null } | null>(
      treasury.vaultAccountId,
      "get_membership",
      { role: agent.role, member: agent.nearAccountId },
    ).catch(() => null);
    return {
      role: agent.role,
      enabled: role?.enabled ?? false,
      member: membership ? { active: membership.active, usesLeft: membership.max_uses === null ? null : membership.max_uses - membership.used_uses } : null,
      allows: role?.description?.details ?? [],
      budgets: role?.budgets ?? [],
      chainId: PROFILE.chainId,
      companyWallet: wallet?.address ? getAddress(hexOf(wallet.address)) : null,
    };
  }

  /**
   * What happened, as the chains record it. Operations come from the vault on
   * NEAR (who, which role, what, its state) and are confirmed on the EVM chain
   * (mined, success or reverted). The database only says which operations to
   * look up and gives names. Refusals and dry runs never reach a chain: they are
   * listed apart, as MandateOS's own record.
   */
  async activity(organizationId: string) {
    const treasury = await this.requireTreasury(organizationId);
    const [rows, records, agents, labels] = await Promise.all([
      this.prisma.operation.findMany({ where: { organizationId }, include: { agent: true }, orderBy: { createdAt: "desc" }, take: ACTIVITY_LIMIT }),
      this.prisma.auditLog.findMany({ where: { organizationId, action: { in: ["operation.refused", "operation.allowed"] } }, orderBy: { createdAt: "desc" }, take: 50 }),
      this.prisma.agent.findMany({ where: { organizationId } }),
      this.labels(organizationId),
    ]);
    const describeRequest = (target: Hex, calldata: Hex, value: bigint): string | null => {
      try {
        return describeCall(target, calldata, value, { profile: PROFILE, labels });
      } catch {
        return null;
      }
    };
    const agentByAccount = new Map(agents.map((agent) => [agent.nearAccountId, agent.name]));

    const operations = [];
    for (const row of rows) {
      const vaultAccountId = row.vaultAccountId ?? treasury.vaultAccountId;
      const recorded = await this.ledgerEntry(vaultAccountId, row.opId).catch(() => null);
      if (!recorded) continue; // unknown to the vault: never shown as if it were on chain
      const { operation, evmHash, receipt } = recorded;
      operations.push({
        opId: row.opId,
        at: new Date(Number(BigInt(operation.created_at_ns) / NANOS_PER_MS)).toISOString(),
        actor: operation.role === "__dao__" ? "Members (DAO vote)" : agentByAccount.get(operation.member) ?? operation.member,
        role: operation.role === "__dao__" ? null : operation.role,
        reference: operation.request.reference,
        chainId: operation.request.chain_id,
        chain: chainName(operation.request.chain_id),
        summary: describeRequest(getAddress(hexOf(operation.request.target)), hexOf(operation.request.calldata), BigInt(operation.request.value)),
        vaultState: operation.state,
        nonce: operation.evm_nonce,
        evm: evmHash ? { hash: evmHash, status: receipt?.status ?? "not mined", blockNumber: receipt?.blockNumber ?? null } : null,
        nearAuthorizationTxHash: row.nearAuthorizationTxHash,
        vaultAccountId,
      });
    }

    // Every transaction the wallet sends takes the next nonce, and only the vault
    // hands nonces out: the chain's count must equal the vault's.
    const integrity = [];
    for (const chainId of [PROFILE.chainId, ...Object.keys(this.config.extraRpcUrls ?? {}).map(Number)]) {
      const wallet = await this.near.viewFunction<{ address: number[] | null; next_nonce: number } | null>(treasury.vaultAccountId, "get_wallet", { chain_id: chainId }).catch(() => null);
      if (!wallet?.address) continue;
      const address = getAddress(hexOf(wallet.address));
      const onChain = await this.chain.nonce(chainId, address).catch(() => null);
      const vault = Number(wallet.next_nonce);
      integrity.push({
        chainId,
        chain: chainName(chainId),
        address,
        walletNonce: onChain,
        vaultNonce: vault,
        status: onChain === null ? "unknown" : onChain === vault ? "ok" : onChain < vault ? "pending" : "alert",
      });
    }

    const requests = records.map((record) => {
      const metadata = (record.metadata ?? {}) as Record<string, unknown>;
      const allowed = record.action === "operation.allowed";
      const target = typeof metadata.target === "string" ? metadata.target as Hex : null;
      const calldata = typeof metadata.calldata === "string" ? metadata.calldata as Hex : null;
      return {
        kind: allowed ? ("allowed" as const) : ("refusal" as const),
        at: record.createdAt.toISOString(),
        agent: agents.find((agent) => agent.id === record.actorId)?.name ?? record.actorId,
        reference: record.targetId ?? "",
        reason: allowed ? null : explainRefusal(String(metadata.reason ?? "")),
        summary: target && calldata ? describeRequest(target, calldata, BigInt(String(metadata.value ?? "0"))) : null,
        // What the agent asked for: a member can turn a refusal into a vote.
        request: target && calldata
          ? { chainId: typeof metadata.chainId === "number" ? metadata.chainId : PROFILE.chainId, to: target, data: calldata, value: String(metadata.value ?? "0") }
          : null,
      };
    });
    return { operations, integrity, requests };
  }

  /**
   * One operation as recorded by the vault and, once signed, by the EVM chain.
   * Settled entries never change again and are kept in memory.
   */
  private async ledgerEntry(vaultAccountId: string, opIdHex: string) {
    const key = `${vaultAccountId}:${opIdHex}`;
    const settled = this.ledger.get(key);
    if (settled) return settled;
    const operation = await this.near.viewFunction<LedgerOperation | null>(vaultAccountId, "get_operation", { op_id: Array.from(Buffer.from(opIdHex.slice(2), "hex")) });
    if (!operation) return null;
    const evmHash = operation.signed_transaction ? keccak256(bytesToHex(Uint8Array.from(operation.signed_transaction))) : null;
    const receipt = evmHash ? await this.chain.receipt(operation.request.chain_id, evmHash).catch(() => null) : null;
    const entry = { operation, evmHash, receipt };
    const final = ["Confirmed", "Failed", "Cancelled", "Vetoed", "Expired"].includes(operation.state) && (!evmHash || receipt);
    if (final) this.ledger.set(key, entry);
    return entry;
  }

  private readonly ledger = new Map<string, { operation: LedgerOperation; evmHash: Hex | null; receipt: { status: "success" | "reverted"; blockNumber: string } | null }>();


  // -------------------------------------------------------------------------

  // NEAR RPC reads are paced (rate limits): cache them briefly and share
  // in-flight requests so a console page does not queue dozens of calls.
  // Past the TTL, a settled value is still served for up to STALE_MS while one
  // refresh runs in the background; writes call forget() to drop it at once.
  private readonly cache = new Map<string, { at: number; value: Promise<unknown>; settled: boolean; refreshing?: boolean }>();
  private static readonly STALE_MS = 90_000;

  private memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < ttlMs) return hit.value as Promise<T>;
    if (hit && hit.settled && age < OmniRolesService.STALE_MS) {
      if (!hit.refreshing) {
        hit.refreshing = true;
        load().then(
          (fresh) => { if (this.cache.get(key) === hit) this.cache.set(key, { at: Date.now(), value: Promise.resolve(fresh), settled: true }); },
          () => { hit.refreshing = false; },
        );
      }
      return hit.value as Promise<T>;
    }
    const value = load();
    const entry = { at: Date.now(), value: value as Promise<unknown>, settled: false };
    this.cache.set(key, entry);
    value.then(() => { entry.settled = true; }, () => { if (this.cache.get(key) === entry) this.cache.delete(key); });
    return value;
  }

  private view<T>(accountId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.memo(`view:${accountId}:${method}:${JSON.stringify(args)}`, 6_000, () => this.near.viewFunction<T>(accountId, method, args));
  }

  private cached(kind: "keys", accountId: string): Promise<{ keys: unknown[] }>;
  private cached(kind: "account", accountId: string): Promise<{ code_hash: string }>;
  private cached(kind: "keys" | "account", accountId: string): Promise<unknown> {
    return this.memo<unknown>(`${kind}:${accountId}`, 30_000, () => (kind === "keys" ? this.near.getAccessKeys(accountId) : this.near.getAccount(accountId)));
  }

  /** Drop cached reads of this organization's DAO and vault (after a member's transaction). */
  async refresh(organizationId: string): Promise<void> {
    const treasury = await this.treasury(organizationId);
    if (!treasury) return;
    this.forget(treasury.vaultAccountId);
    this.forget(treasury.daoAccountId);
  }

  private forget(accountId: string): void {
    for (const key of this.cache.keys()) if (key.includes(accountId)) this.cache.delete(key);
  }

  private async labels(organizationId: string): Promise<Record<string, string>> {
    const wallets = await this.prisma.supplierWallet.findMany({ where: { organizationId, active: true }, include: { supplier: true } }).catch(() => []);
    const labels: Record<string, string> = Object.fromEntries(wallets.map((wallet) => [wallet.address, wallet.supplier.name]));
    const treasury = await this.treasury(organizationId);
    if (treasury) {
      const wallet = await this.view<{ address: number[] | null } | null>(treasury.vaultAccountId, "get_wallet", { chain_id: treasury.baseChainId }).catch(() => null);
      if (wallet?.address) labels[getAddress(hexOf(wallet.address))] = "company wallet";
    }
    return labels;
  }

  private async treasury(organizationId: string) {
    return this.prisma.treasury.findUnique({ where: { organizationId_environment: { organizationId, environment: "uat" } } });
  }

  private async requireTreasury(organizationId: string) {
    const treasury = await this.treasury(organizationId);
    if (!treasury) throw new OmniRolesError(404, "treasury_missing", "create the treasury first");
    return treasury;
  }

  private async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.near.getAccount(accountId);
      return true;
    } catch {
      return false;
    }
  }

  private artifactCache = new Map<string, { base64: string; sha256: string }>();

  private async artifact(name = "vault.wasm"): Promise<{ base64: string; sha256: string }> {
    const cached = this.artifactCache.get(name);
    if (cached) return cached;
    const candidates = [
      resolve(this.config.artifactsDir, name),
      resolve(process.cwd(), "contracts/res", name),
      resolve(process.cwd(), "../../contracts/res", name),
    ];
    for (const candidate of candidates) {
      try {
        const wasm = await readFile(candidate);
        const artifact = { base64: wasm.toString("base64"), sha256: createHash("sha256").update(wasm).digest("hex") };
        this.artifactCache.set(name, artifact);
        return artifact;
      } catch {
        // next candidate
      }
    }
    throw new OmniRolesError(500, "artifact_missing", `${name} not found`);
  }
}

/** Plain-English reason for a vault refusal code. */
export function explainRefusal(reason: string): string {
  // Guard refusals carry their own sentence: GUARD:<code>:<reasons>.
  const guard = reason.match(/^GUARD:[a-z_]+:(.*)$/s);
  if (guard) return `Guard: ${guard[1]}`;
  const status = reason.match(/"status":"([a-zA-Z]+)"/)?.[1];
  const byStatus: Record<string, string> = {
    parameterNotAllowed: "a parameter is not allowed by the role (recipient, token or address)",
    parameterNotOneOfAllowed: "a parameter is not in the allowed list",
    parameterLessThanAllowed: "an amount is below the allowed minimum",
    parameterGreaterThanAllowed: "an amount is above the allowed maximum",
    allowanceExceeded: "the amount exceeds what is left of the budget this period",
    unknownAllowance: "the role refers to a budget that does not exist",
    notEveryArrayElementPasses: "an item of the list is not allowed",
    noArrayElementPasses: "no item of the list is allowed",
    calldataOutOfBounds: "the transaction data is malformed",
    calldataTooShort: "the transaction data is malformed",
    conditionsInvalid: "the role's conditions are invalid",
  };
  if (status && byStatus[status]) return byStatus[status];
  const byCode: Array<[string, string]> = [
    ["TargetNotAllowed", "the contract is not allowed by the role"],
    ["FunctionNotAllowed", "the function is not allowed by the role"],
    ["SendNotAllowed", "sending ETH is not allowed by the role"],
    ["ERR_ALLOWANCE_AMOUNT_MISMATCH", "the declared amount differs from the transaction"],
    ["ERR_MEMBERSHIP_NOT_FOUND", "the agent has no such role"],
    ["ERR_MEMBERSHIP_REVOKED", "the agent's role was revoked"],
    ["ERR_MEMBERSHIP_EXPIRED", "the agent's role has expired"],
    ["ERR_MEMBERSHIP_USES_EXHAUSTED", "the agent used all its allowed operations"],
    ["ERR_ROLE_NOT_FOUND", "the role does not exist"],
    ["ERR_ROLE_DISABLED", "the role is disabled"],
    ["ERR_PAUSED", "operations are paused by the council"],
    ["ERR_REFERENCE_ALREADY_USED", "this invoice reference was already paid"],
    ["ERR_WALLET_NOT_DERIVED", "the company wallet does not exist yet"],
  ];
  return byCode.find(([code]) => reason.includes(code))?.[1] ?? reason;
}
