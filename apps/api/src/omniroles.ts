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
  membersProposalArgs,
  proposalArgs,
  PROPOSAL_MARKER,
  hexOf,
  type ChainProfile,
  type RoleDraft,
  type RuleChange,
  type VaultCall,
} from "@mandateos/sdk/roles";
import bs58 from "bs58";
import { createPublicClient, erc20Abi, formatUnits, getAddress, http, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { NEAR_ACCOUNT_ID, NEAR_PROVIDER_ID, nearUserEmail } from "./near-auth.js";

export class OmniRolesError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 500,
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
  /** Gas and fees for a DAO transaction; generous, since it is signed after the vote and the veto window. */
  fees(input: { chainId: number; from: Hex; to: Hex; value: bigint; data: Hex; gas?: bigint | undefined }): Promise<{ gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
}

/** Gas limit (before headroom) of a voted call that cannot be estimated. */
const FALLBACK_GAS = 1_000_000n;

/** Lowest max fee a voted transaction gets, per chain (wei). */
const FEE_FLOOR_WEI: Record<number, bigint> = { 1: 20_000_000_000n, 11155111: 5_000_000_000n, 8453: 50_000_000n, 84532: 50_000_000n };

export class RpcOmniRolesChain implements OmniRolesChain {
  private readonly client;

  constructor(rpcUrl: string, private readonly rpcUrls: Record<number, string> = {}) {
    this.client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    this.rpcUrls = { 84532: rpcUrl, 11155111: "https://ethereum-sepolia-rpc.publicnode.com", ...rpcUrls };
  }

  async fees(input: { chainId: number; from: Hex; to: Hex; value: bigint; data: Hex; gas?: bigint | undefined }) {
    const url = this.rpcUrls[input.chainId];
    if (!url) throw new OmniRolesError(400, "unsupported_chain", `no RPC configured for chain ${input.chainId}`);
    const client = createPublicClient({ transport: http(url) });
    // A call that depends on an earlier one in the same proposal (approve, then
    // supply) cannot be estimated yet, and a public RPC can fail the estimate:
    // fall back to a wide limit. Unused gas is not paid; running out reverts
    // the voted transaction (a bridge deposit burns ~670k on Sepolia).
    const estimate = input.gas ?? await client.estimateGas({ account: input.from, to: input.to, value: input.value, data: input.data }).catch(() => FALLBACK_GAS);
    const gasPrice = await client.getGasPrice();
    // Signed after the vote and the veto window: leave room for fees to rise.
    const floor = FEE_FLOOR_WEI[input.chainId] ?? 1_000_000_000n;
    const priority = input.chainId === 11155111 || input.chainId === 1 ? 1_000_000_000n : 1_000_000n;
    const maxFeePerGas = gasPrice * 3n + priority > floor ? gasPrice * 3n + priority : floor;
    return {
      gasLimit: (estimate * 13n) / 10n,
      maxFeePerGas,
      maxPriorityFeePerGas: priority < maxFeePerGas ? priority : maxFeePerGas,
    };
  }

  async balances(address: Hex, profile: ChainProfile) {
    const eth = await this.client.getBalance({ address });
    const tokens = await Promise.all(profile.tokens.map(async (token) => {
      const amount = await this.client
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

  private daoPolicy(plan: { council: Array<{ nearAccountId: string }> }) {
    return councilPolicy(plan.council.map((member) => member.nearAccountId), {
      proposalBond: this.config.proposalBondYocto,
      proposalPeriodNs: this.config.proposalPeriodNs,
    });
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
    const drafts: DaoTransactionDraft[] = [];
    for (const transaction of input.transactions) {
      const wallet = await this.view<{ address: number[] | null } | null>(treasury.vaultAccountId, "get_wallet", { chain_id: transaction.chainId }).catch(() => null);
      if (!wallet?.address) {
        throw new OmniRolesError(409, "wallet_missing", `the company wallet is not created on ${chainName(transaction.chainId)} yet: propose it first`);
      }
      const from = getAddress(hexOf(wallet.address));
      const to = getAddress(transaction.to);
      const data = (transaction.data && transaction.data !== "0x" ? transaction.data : "0x") as Hex;
      const value = BigInt(transaction.value ?? "0");
      const fees = await this.chain.fees({ chainId: transaction.chainId, from, to, value, data, gas: transaction.gas ? BigInt(transaction.gas) : undefined });
      drafts.push({
        chainId: transaction.chainId,
        to,
        value: value.toString(),
        data,
        gasLimit: fees.gasLimit.toString(),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
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
    try {
      policy = this.daoPolicy({ council: members.map((nearAccountId) => ({ nearAccountId })) });
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
    const [lastId, policy, rules, paused, daoTransactions] = await Promise.all([
      this.view<number>(treasury.daoAccountId, "get_last_proposal_id"),
      this.view<{ default_vote_policy: { threshold: unknown }; roles: Array<{ kind: unknown }>; proposal_period: string }>(treasury.daoAccountId, "get_policy"),
      this.view<QueuedRule[]>(treasury.vaultAccountId, "list_rule_changes", { before: null, limit: 50 }),
      this.view<boolean>(treasury.vaultAccountId, "is_paused"),
      this.view<DaoOperation[]>(treasury.vaultAccountId, "list_dao_transactions", { limit: 50 }).catch(() => [] as DaoOperation[]),
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
      dao: { accountId: treasury.daoAccountId, members, threshold: policy.default_vote_policy.threshold, proposalPeriodNs: policy.proposal_period },
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
            kind: proposal.kind,
            submittedAt: new Date(Number(BigInt(proposal.submission_time) / NANOS_PER_MS)).toISOString(),
            expiresAt: new Date(Number((BigInt(proposal.submission_time) + BigInt(policy.proposal_period)) / NANOS_PER_MS)).toISOString(),
            changes: calls
              ? calls.map((call) => describeVaultCall(call, context))
              : (() => {
                const policyChange = describePolicyChange(proposal.kind);
                return policyChange
                  ? [{ title: policyChange.title, details: policyChange.details }]
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

  async checkOperation(
    organizationId: string,
    agent: { agentId: string; nearAccountId: string; role: string },
    request: Record<string, unknown>,
  ) {
    const treasury = await this.requireTreasury(organizationId);
    // Never cached: an agent must see the vault's current budgets and rules.
    const result = await this.near.viewFunction<{ allowed: boolean; reason: string | null; requires_delay: boolean; requires_cosign: boolean }>(
      treasury.vaultAccountId,
      "check_operation",
      { role: agent.role, member: agent.nearAccountId, request },
    );
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
    return result;
  }

  async activity(organizationId: string) {
    const [operations, refusals] = await Promise.all([
      this.prisma.operation.findMany({ where: { organizationId }, include: { agent: true }, orderBy: { createdAt: "desc" }, take: 50 }),
      this.prisma.auditLog.findMany({ where: { organizationId, action: { in: ["operation.refused", "operation.allowed"] } }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    const agents = await this.prisma.agent.findMany({ where: { organizationId } });
    const labels = await this.labels(organizationId);
    const describe = (metadata: Record<string, unknown>): string | null => {
      if (typeof metadata.target !== "string" || typeof metadata.calldata !== "string") return null;
      try {
        return describeCall(metadata.target as Hex, metadata.calldata as Hex, BigInt(String(metadata.value ?? "0")), { profile: PROFILE, labels });
      } catch {
        return null;
      }
    };
    const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id;
    // Transactions voted by the DAO: described from the vault, where their calldata lives.
    const treasury = await this.treasury(organizationId);
    const daoTransactions = treasury
      ? await this.view<DaoOperation[]>(treasury.vaultAccountId, "list_dao_transactions", { limit: 50 }).catch(() => [])
      : [];
    const daoSummary = new Map<string, string>(daoTransactions.map((item) => [hexOf(item.op_id), describeCall(
      getAddress(hexOf(item.request.target)),
      hexOf(item.request.calldata),
      BigInt(item.request.value),
      { profile: PROFILE, labels },
    )]));
    const items = [
      ...operations.map((operation) => ({
        kind: "operation" as const,
        at: operation.createdAt.toISOString(),
        agent: operation.agent?.name ?? "Members (DAO vote)",
        reference: operation.reference,
        state: operation.state,
        amount: operation.amount.toString(),
        txHash: operation.txHash,
        opId: operation.opId,
        reason: null as string | null,
        summary: daoSummary.get(operation.opId) ?? null,
        request: null as { chainId: number; to: string; data: string; value: string } | null,
      })),
      ...refusals.map((refusal) => {
        const metadata = (refusal.metadata ?? {}) as Record<string, unknown>;
        const allowed = refusal.action === "operation.allowed";
        return {
          kind: allowed ? ("allowed" as const) : ("refusal" as const),
          at: refusal.createdAt.toISOString(),
          agent: agentName(refusal.actorId),
          reference: refusal.targetId ?? "",
          state: allowed ? "Allowed" : "Refused",
          amount: null as string | null,
          txHash: null as string | null,
          opId: null as string | null,
          reason: allowed ? null : explainRefusal(String(metadata.reason ?? "")),
          summary: describe(metadata),
          // What the agent asked for: members can turn a refusal into a vote.
          request: typeof metadata.target === "string" && typeof metadata.calldata === "string"
            ? { chainId: PROFILE.chainId, to: metadata.target, data: metadata.calldata, value: String(metadata.value ?? "0") }
            : null,
        };
      }),
    ].sort((left, right) => right.at.localeCompare(left.at));
    return { items };
  }

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

  private artifactCache: { base64: string; sha256: string } | null = null;

  private async artifact(): Promise<{ base64: string; sha256: string }> {
    if (this.artifactCache) return this.artifactCache;
    const candidates = [
      resolve(this.config.artifactsDir, "vault.wasm"),
      resolve(process.cwd(), "contracts/res/vault.wasm"),
      resolve(process.cwd(), "../../contracts/res/vault.wasm"),
    ];
    for (const candidate of candidates) {
      try {
        const wasm = await readFile(candidate);
        this.artifactCache = { base64: wasm.toString("base64"), sha256: createHash("sha256").update(wasm).digest("hex") };
        return this.artifactCache;
      } catch {
        // next candidate
      }
    }
    throw new OmniRolesError(500, "artifact_missing", "vault.wasm not found");
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
    allowanceExceeded: "the budget for this period is exhausted",
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
