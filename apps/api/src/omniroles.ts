import { hexToBytes } from "viem";
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

import type { Prisma, PrismaClient } from "@euthyna/db";
import {
  BASE_SEPOLIA,
  budgetsOf,
  compileRole,
  decodeVaultCalls,
  describeCall,
  describeVaultCall,
  describeDaoTransactions,
  chainName,
  EUTHYNA_EXECUTOR,
  type DaoTransactionDraft,
  councilPolicy,
  describePolicyChange,
  describeProceedsProposal,
  describeRegistryProposal,
  describeSharesProposal,
  formatNear,
  omniRecipient,
  OMNI_NEAR_TESTNET,
  proceedsToEvmKinds,
  registryProposalKind,
  hasShareholdersRole,
  membersProposalArgs,
  MAX_BRIDGE_FEE_WEI,
  nearRecipient,
  parseNear,
  proposalOf,
  shareRevenueCall,
  stringHash,
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
  NEAR_TESTNET_TOKENS,
  withSealedOrdersMember,
  euroPayoutBudgetKey,
  type SealedBeneficiary,
  type BankConfig,
  type BankPayout,
  type BankPermission,
} from "@euthyna/sdk/roles";
import { BASE_SEPOLIA_UNISWAP, describeSealedProposal, sealedCancelKind, sealedOrderKind } from "@euthyna/sdk";
import bs58 from "bs58";
import { base58Encode, cardAccountIdOf, SOLANA_DEVNET, solanaRpc } from "@euthyna/sdk";
import { vaultLogs, type VaultLog, type VaultLogStore } from "./chain-activity.js";
import { usdPrices, usdValue } from "./prices.js";
import { bytesToHex, encodeFunctionData, erc20Abi, formatUnits, getAddress, keccak256, parseAbi, parseUnits, type Hex, type PublicClient } from "viem";

import { chainClient, estimateCalls, GasEstimateError, rpcUrls, type GasCall } from "./evm-gas.js";
import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { inBackground } from "./rpc-limiter.js";
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

/**
 * Reads are at finality "final", a few blocks behind the transaction that was
 * just sent: a fresh account can look missing for a couple of seconds.
 */
export async function untilFinal(check: () => Promise<boolean>, attempts = 10, delayMs = 1_500): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    if (await check()) return true;
    if (attempt >= attempts) return false;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/** Where the bank signer runs: what a vault votes into its bank config. */
export interface BankSignerDeployment {
  outlayerId: string;
  signerUrl: string;
  signerHash: string;
  secretsOwner: string;
  secretsProfile: string;
  /** The enclave's X25519 key (hex), from its `pubkey` output: beneficiaries are sealed to it. */
  boxKey: string;
  /** The enclave's OutLayer project ("owner/name"): its secrets follow its versions, so a vault can follow them. */
  project?: string | undefined;
}

/** Fees of the EURC transfer on Base Sepolia (caps; the DAO gas policy bounds them). */
const BANK_TRANSFER_GAS = { gas_limit: "120000", max_fee_per_gas: "500000000", max_priority_fee_per_gas: "10000000" };

export interface OmniRolesConfig {
  nearNetwork: string;
  daoFactoryId: string;
  /** Nomos factory: creates the vault as <slug>.<nomosId> from a published version. */
  nomosId: string;
  /** Solana RPC for the company's Solana wallet balance (devnet by default). */
  solanaRpcUrl?: string;
  /** Public NEAR transaction index (FastNEAR tx API): activity read from the vault's logs. */
  txIndexerUrl?: string;
  mpcContractId: string;
  artifactsDir: string;
  accountParent: string;
  daoCreateDepositYocto: string;
  /** Funds the shares account: contract storage (~2.2 NEAR) and holder registrations. */
  sharesDepositYocto?: string;
  /** Revenue epoch of new shares contracts, in seconds. */
  sharesEpochSeconds?: number;
  /** Omni Bridge API (transfer fees). Default: the testnet one. */
  omniBridgeApi?: string;
  /** Public directory of AI companies; unset disables listing. */
  registryId?: string | undefined;
  /** Earlier directories, for companies whose vault comes from an earlier Nomos. */
  previousRegistryIds?: string[] | undefined;
  /** contracts/sealed-orders; unset turns sealed orders off. */
  sealedOrdersId?: string | undefined;
  /** The bank signer (bank-signer/) deployed on OutLayer; unset turns euro payouts off. */
  bankSigner?: BankSignerDeployment | undefined;
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
  /** Supplied balances in lending pools (Aave V3: aTokens), per asset. */
  lendingPositions?(address: Hex, profile: ChainProfile): Promise<Array<{ protocol: string; symbol: string; amount: string }>>;
  /** The mined result of a transaction, or null while it is not mined. */
  receipt(chainId: number, hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: string } | null>;
}

/** NEAR storage: 1e19 yocto per byte; top the vault up below 0.5 NEAR free. */
const STORAGE_PRICE_PER_BYTE = 10_000_000_000_000_000_000n;
const STORAGE_LOW_YOCTO = 500_000_000_000_000_000_000_000n;
const STORAGE_TOP_UP_YOCTO = 1_000_000_000_000_000_000_000_000n;
/** The activation job: how often an idle vault is read, how long after a veto window ends, and backoffs. */
// An idle vault costs two reads (its rules, its voted transactions): every 5 minutes. A member's
// vote in the console wakes the vault at once (`refresh`); known dates (a veto window's end, a
// payroll date) wake it on time.
const IDLE_RECHECK_MS = 300_000;
const DUE_MARGIN_MS = 3_000;
const ERROR_RECHECK_MS = 30_000;
const BROKEN_RECHECK_MS = 15 * 60_000;
const STORAGE_CHECK_EVERY_MS = 30 * 60_000;
const BUSY_RECHECK_NS = 20_000_000_000n;
/** A standing order's run is tried at most this many times; then it waits for the members. */
const STANDING_ORDER_ATTEMPTS = 3;
/** Wait before trying a refused run again: 15 minutes, then 30. */
const STANDING_ORDER_BACKOFF_NS = 15n * 60n * 1_000_000_000n;
/** How often a vault that follows its enclave project looks for a new version. */
const FOLLOW_RECHECK_NS = 60n * 60n * 1_000_000_000n;
/**
 * What only a rule changes (standing orders, the enclave's source) is read again when the vault's
 * rule list changes, after the keeper runs something, or at the latest after this long.
 */
const RULE_FACTS_TTL_MS = 60 * 60_000;
/** A vault that pays IBANs is read every minute: an agent's payout must not wait for the idle read. */
const BANK_RECHECK_NS = 60n * 1_000_000_000n;
/** A refused rule is tried again after 2, 4, 8… minutes, at most every 30. */
const REFUSED_RULE_FIRST_WAIT_MS = 2 * 60_000;
const REFUSED_RULE_MAX_WAIT_MS = 30 * 60_000;
/** Vaults checked at once by the job. */
const ACTIVATION_LANES = 3;

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

  private aTokens = new Map<string, Hex>();

  async lendingPositions(address: Hex, profile: ChainProfile) {
    const client = this.client(profile.chainId);
    const abi = parseAbi([
      "function ADDRESSES_PROVIDER() view returns (address)",
      "function getPoolDataProvider() view returns (address)",
      "function getReserveTokensAddresses(address) view returns (address,address,address)",
    ]);
    const positions: Array<{ protocol: string; symbol: string; amount: string }> = [];
    for (const lending of Object.values(profile.lending ?? {})) {
      if (!lending) continue;
      for (const asset of lending.assets) {
        const key = `${profile.chainId}:${asset.toLowerCase()}`;
        let aToken = this.aTokens.get(key);
        if (!aToken) {
          const provider = await client.readContract({ address: lending.pool, abi, functionName: "ADDRESSES_PROVIDER" });
          const dataProvider = await client.readContract({ address: provider, abi, functionName: "getPoolDataProvider" });
          [aToken] = await client.readContract({ address: dataProvider, abi, functionName: "getReserveTokensAddresses", args: [asset] });
          this.aTokens.set(key, aToken);
        }
        const amount = await client.readContract({ address: aToken, abi: erc20Abi, functionName: "balanceOf", args: [address] });
        const token = profile.tokens.find((item) => item.address.toLowerCase() === asset.toLowerCase());
        if (amount > 0n && token) positions.push({ protocol: lending.name, symbol: token.symbol, amount: formatUnits(amount, token.decimals) });
      }
    }
    return positions;
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

type NearOperationView = {
  op_id: number[];
  member: string;
  role: string;
  state: "Pending" | "Confirmed" | "Failed" | "Unconfirmed";
  created_at_ns: string;
  request: { token: string; receiver_id: string; amount: string; memo: string | null; reference: string };
};

/** "Refilled Larry's card with 5 USDC", or "Sent 5 USDC to bob.testnet". */
export function nearTransferSummary(request: { amount: string; receiver_id: string }, token: { symbol: string; decimals: number }, receiver: string): string {
  const amount = `${Number(formatUnits(BigInt(request.amount), token.decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${token.symbol}`;
  return receiver.endsWith("'s card") ? `Refilled ${receiver} with ${amount}` : `Sent ${amount} to ${receiver}`;
}

/** "Larry's card" when the account is an agent's spending card, else the account. */
export function cardOwner(accountId: string, agents: Array<{ name: string; nearAccountId: string | null }>): string {
  for (const agent of agents) {
    if (!agent.nearAccountId) continue;
    try {
      if (cardAccountIdOf(agent.nearAccountId) === accountId) return `${agent.name}'s card`;
    } catch { /* not an Euthyna agent account */ }
  }
  return accountId;
}

type SolanaOperationView = {
  member: string;
  role: string;
  state: string;
  signature: number[] | null;
  request: { asset: "Sol" | { Spl: { mint: number[] } }; to: number[]; amount: string; reference: string };
};

const short = (text: string) => `${text.slice(0, 4)}…${text.slice(-4)}`;

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

type EpochView = { near: string; token: string; voted_shares: string };

type SharesInfoView = {
  epoch_ns: string;
  current_epoch: number;
  current_epoch_ends_ns: string;
  current: EpochView;
  last: EpochView;
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
  steady_now: string;
  provable_last_epoch: string;
  proofs: Array<{ epoch: number; shares: string; verified: boolean }>;
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
const ONE_NEAR = 1_000_000_000_000_000_000_000_000n;

function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "company";
}

function nowNs(): bigint {
  return BigInt(Date.now()) * NANOS_PER_MS;
}

/** Reads the Activity page makes at once: the screen's other calls (a sign-in, a vote) wait behind at most these. */
const ACTIVITY_READS = 2;

/** Runs `work` on each item, at most `size` at a time, keeping the items' order in the result. */
async function inPool<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
}

export class OmniRolesService {
  private activationRunning = false;
  /** vault -> when the activation job reads it next (ms). Empty after a restart: every vault is read once. */
  private readonly nextActivationCheck = new Map<string, number>();
  private readonly storageCheckedAt = new Map<string, number>();
  /** Per vault: what only rules change, read once and kept until the rule list moves (see RULE_FACTS_TTL_MS). */
  private readonly ruleFacts = new Map<string, { fingerprint: string; values: Map<string, { value: unknown; readAt: number }> }>();
  private readonly followCheckedAt = new Map<string, number>();
  /** Bank payouts whose record no longer changes (refused, or transfer queued). */
  private readonly settledPayouts = new Map<string, BankPayout>();
  /** Rules the vault refused for now, and when to try each again. */
  private readonly refusedRules = new Map<string, { tries: number; retryAt: number }>();

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
    const vaultAccountId = `${slug}.${this.config.nomosId}`;
    for (const accountId of [daoAccountId, vaultAccountId]) {
      if (accountId.length > 64) throw new OmniRolesError(400, "account_id_too_long", `${accountId} is longer than 64 characters`);
    }
    const version = await this.latestVaultVersion();
    return {
      daoAccountId,
      vaultAccountId,
      council,
      threshold: Math.ceil((2 * council.length) / 3),
      ruleDelaySeconds: this.config.ruleDelayNs / 1e9,
      vaultWasmSha256: version.sha256,
    };
  }

  // -------------------------------------------------------------------------
  // Members: NEAR accounts entered by an admin before the DAO exists
  // -------------------------------------------------------------------------

  /** The DAO's council members as on chain (seat recovery). */
  async councilOf(organizationId: string): Promise<string[]> {
    const treasury = await this.requireTreasury(organizationId);
    const policy = await this.near.viewFunction<{ roles: Array<{ name: string; kind: unknown }> }>(treasury.daoAccountId, "get_policy", {});
    return policy.roles.filter((role) => role.name === "council").flatMap((role) => ((role.kind as { Group?: string[] })?.Group ?? []));
  }

  /** The company that owns this DAO, once its treasury is active. */
  async organizationOfDao(daoAccountId: string): Promise<string | null> {
    const treasury = await this.prisma.treasury.findFirst({ where: { daoAccountId, status: "active" } });
    return treasury?.organizationId ?? null;
  }

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
    const council = plan.council.map((member) => member.nearAccountId);
    const version = await this.latestVaultVersion();
    const deposit = await this.near.viewFunction<string>(this.config.nomosId, "vault_deposit", { code_hash: version.codeHash });

    // Resumable: a DAO or vault left by an earlier attempt for the same council
    // is reused; one that belongs to someone else means the name is taken.
    const daoReady = await this.ownDao(plan.daoAccountId, council);
    const vaultReady = await this.ownVault(plan.vaultAccountId, plan.daoAccountId);

    // Check the relayer can pay for what is left, so a half-made company is rare.
    const needed = (daoReady ? 0n : BigInt(this.config.daoCreateDepositYocto)) + (vaultReady ? 0n : BigInt(deposit)) + ONE_NEAR;
    const relayer = this.near.relayerAccountId();
    const balance = BigInt((await this.near.getAccount(relayer).catch(() => ({ amount: "0" }))).amount);
    if (balance < needed) {
      throw new OmniRolesError(503, "relayer_low_funds", `${relayer} needs ${formatNear(needed)} NEAR to create this company and holds ${formatNear(balance)}`);
    }

    let daoTransaction = "existing";
    if (!daoReady) {
      const daoArgs = {
        config: { name: `${daoName} treasury DAO`, purpose: "Set the rules AI agents follow with company funds", metadata: "" },
        policy: this.daoPolicy(plan),
      };
      daoTransaction = await this.near.callFunction(
        this.config.daoFactoryId,
        "create",
        { name: plan.daoAccountId.split(".")[0], args: Buffer.from(JSON.stringify(daoArgs)).toString("base64") },
        "150000000000000",
        this.config.daoCreateDepositYocto,
      );
      if (!(await untilFinal(() => this.ownDao(plan.daoAccountId, council)))) {
        throw new OmniRolesError(500, "dao_not_created", `${this.config.daoFactoryId} did not create ${plan.daoAccountId} (transaction ${daoTransaction})`);
      }
    }

    let vaultTransaction = "existing";
    if (!vaultReady) {
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
        council,
        settlement_config: null,
      };
      // Nomos creates the vault with no access key, owned by the DAO, from the
      // version pinned here; only the DAO can later move it to another version.
      vaultTransaction = await this.near.callFunction(
        this.config.nomosId,
        "create_vault",
        {
          name: plan.vaultAccountId.split(".")[0],
          args: Buffer.from(JSON.stringify(initArgs)).toString("base64"),
          code_hash: version.codeHash,
        },
        "300000000000000",
        deposit,
      );
      if (!(await untilFinal(() => this.ownVault(plan.vaultAccountId, plan.daoAccountId)))) {
        throw new OmniRolesError(500, "vault_not_created", `${this.config.nomosId} did not create ${plan.vaultAccountId} (transaction ${vaultTransaction}); the DAO is kept, try again`);
      }
    }
    await this.prisma.treasury.create({
      data: {
        organizationId,
        environment: "uat",
        nearNetwork: this.config.nearNetwork,
        baseChainId: PROFILE.chainId,
        daoAccountId: plan.daoAccountId,
        vaultAccountId: plan.vaultAccountId,
        vaultWasmSha256: version.sha256,
        status: "wallet_pending",
      },
    });
    return { daoTransaction, vaultTransaction };
  }

  /** True when `daoAccountId` exists and is governed by exactly this council; throws if it is someone else's. */
  private async ownDao(daoAccountId: string, council: string[]): Promise<boolean> {
    if (!(await this.accountExists(daoAccountId))) return false;
    const policy = await this.near.viewFunction<{ roles: Array<{ kind: unknown }> }>(daoAccountId, "get_policy").catch(() => null);
    const members = (policy?.roles ?? []).flatMap((role) => ((role.kind as { Group?: string[] })?.Group ?? [])).sort();
    if (members.join(",") !== [...council].sort().join(",")) {
      throw new OmniRolesError(409, "account_taken", `${daoAccountId} already exists with other members; choose another company name`);
    }
    return true;
  }

  /** True when the vault exists, is owned by this DAO and was made by Nomos; throws if it is someone else's. */
  private async ownVault(vaultAccountId: string, daoAccountId: string): Promise<boolean> {
    if (!(await this.accountExists(vaultAccountId))) return false;
    const [owner, source] = await Promise.all([
      this.near.viewFunction<string>(vaultAccountId, "owner_id").catch(() => null),
      this.near.viewFunction<string>(vaultAccountId, "code_source").catch(() => null),
    ]);
    if (owner !== daoAccountId || source !== this.config.nomosId) {
      throw new OmniRolesError(409, "account_taken", `${vaultAccountId} already exists and is not this company's vault; choose another company name`);
    }
    return true;
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
  private sharesAccountOf(treasury: { vaultAccountId: string; daoAccountId: string }): string {
    // Vaults made before Nomos were <slug>-vault.<parent>; Nomos vaults are <slug>.<nomos>.
    if (treasury.vaultAccountId.includes("-vault.")) return treasury.vaultAccountId.replace(/-vault\./, "-shares.");
    return `${treasury.daoAccountId.split(".")[0]}-shares.${this.config.accountParent}`;
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
        lastEpochVote: await this.lastEpochVote(treasury.daoAccountId, viewer, info),
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
      vaultAccountId: treasury.vaultAccountId,
      info,
      votesCounted: staking === accountId,
      shareholdersVote: hasShareholdersRole(policy),
      lockedTotal,
      me,
    };
  }

  /**
   * A proposal submitted during the last epoch that the viewer voted on: what
   * `prove_vote` needs. Null when there is none.
   */
  private async lastEpochVote(daoAccountId: string, viewer: string, info: SharesInfoView): Promise<number | null> {
    if (info.current_epoch === 0) return null;
    const end = BigInt(info.current_epoch_ends_ns) - BigInt(info.epoch_ns);
    const start = end - BigInt(info.epoch_ns);
    const lastId = await this.view<number>(daoAccountId, "get_last_proposal_id");
    if (lastId === 0) return null;
    const proposals = await this.view<DaoProposal[]>(daoAccountId, "get_proposals", { from_index: Math.max(0, lastId - 100), limit: 100 });
    const voted = proposals.find((proposal) => {
      const submitted = BigInt(proposal.submission_time);
      return submitted >= start && submitted < end && viewer in proposal.votes;
    });
    return voted?.id ?? null;
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
        epochNs: (BigInt(this.config.sharesEpochSeconds ?? 3600) * 1_000_000_000n).toString(),
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
      { type: "Transfer", depositYocto: this.config.sharesDepositYocto ?? "2900000000000000000000000" },
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

  /**
   * Move NEAR held by the DAO (for example sale proceeds) to the company wallet
   * on an EVM chain, as wNEAR through Omni Bridge. Two votes: the bridge
   * storage, then the transfer.
   */
  async proceedsProposals(organizationId: string, input: { chainId: number; amountNear: string }) {
    const treasury = await this.requireTreasury(organizationId);
    let amount: bigint;
    try {
      amount = BigInt(parseNear(input.amountNear));
    } catch (error) {
      throw new OmniRolesError(400, "invalid_amount", error instanceof Error ? error.message : String(error));
    }
    if (amount <= 0n) throw new OmniRolesError(400, "invalid_amount", "the amount must be above zero");
    const wallet = await this.view<{ address: number[] | null } | null>(treasury.vaultAccountId, "get_wallet", { chain_id: input.chainId }).catch(() => null);
    if (!wallet?.address) throw new OmniRolesError(409, "wallet_missing", `the company wallet is not created on ${chainName(input.chainId)} yet`);
    const address = getAddress(hexOf(wallet.address));
    let recipient: string;
    try {
      recipient = omniRecipient(input.chainId, address);
    } catch (error) {
      throw new OmniRolesError(400, "unsupported_chain", error instanceof Error ? error.message : String(error));
    }
    const bridge = OMNI_NEAR_TESTNET.bridge;
    const [policy, perAccount, perTransfer, daoAccount] = await Promise.all([
      this.near.viewFunction<{ roles: Array<{ kind: unknown }> }>(treasury.daoAccountId, "get_policy", {}),
      this.near.viewFunction<string>(bridge, "required_balance_for_account", {}),
      this.near.viewFunction<string>(bridge, "required_balance_for_init_transfer", {}),
      this.near.getAccount(treasury.daoAccountId) as Promise<{ amount: string }>,
    ]);
    const members = policy.roles.flatMap((role) => ((role.kind as { Group?: string[] })?.Group ?? []));
    const registered = await Promise.all(members.map((member) => this.near.viewFunction<unknown>(bridge, "storage_balance_of", { account_id: member }).catch(() => null)));
    const membersToRegister = members.filter((_, index) => !registered[index]);
    const needed = amount + BigInt(perTransfer) + BigInt(perAccount) * BigInt(membersToRegister.length);
    if (BigInt(daoAccount.amount) < needed + 200_000_000_000_000_000_000_000n) {
      throw new OmniRolesError(409, "dao_balance_low", `the DAO holds ${formatNear(daoAccount.amount)}; this needs ${formatNear(needed)} plus what the DAO keeps for its storage`);
    }
    const feeUrl = new URL("/api/v3/transfer-fee", this.config.omniBridgeApi ?? "https://testnet.api.bridge.nearone.org");
    feeUrl.search = new URLSearchParams({ sender: `near:${treasury.daoAccountId}`, recipient, token: `near:${OMNI_NEAR_TESTNET.wrappedNear}`, amount: amount.toString() }).toString();
    let fee: string;
    try {
      const response = await fetch(feeUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      fee = ((await response.json()) as { transferred_token_fee?: string | null }).transferred_token_fee ?? "0";
    } catch (error) {
      throw new OmniRolesError(503, "bridge_fee_unavailable", `the Omni Bridge fee API did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    let kinds: ReturnType<typeof proceedsToEvmKinds>;
    try {
      kinds = proceedsToEvmKinds({ daoAccountId: treasury.daoAccountId, chainId: input.chainId, wallet: address, amountYocto: amount.toString(), feeYocto: fee, membersToRegister, perAccountYocto: perAccount, perTransferYocto: perTransfer });
    } catch (error) {
      throw new OmniRolesError(422, "invalid_transfer", error instanceof Error ? error.message : String(error));
    }
    const draft = (kind: unknown) => {
      const summary = describeProceedsProposal(kind, address)!;
      return { receiverId: treasury.daoAccountId, args: proposalOf(summary.title, kind), deposit: this.config.proposalBondYocto, title: summary.title, summary: [summary] };
    };
    return { companyWallet: address, messageAccount: kinds.messageAccount, proposals: [draft(kinds.storage), draft(kinds.transfer)] };
  }

  /** What the public directory knows about this company, read from chain. */
  async directory(organizationId: string) {
    const treasury = await this.requireTreasury(organizationId);
    const registryId = await this.registryFor(treasury.vaultAccountId);
    const sharesAccountId = this.sharesAccountOf(treasury);
    const shares = await this.view<{ dao_id: string }>(sharesAccountId, "info").catch(() => null);
    const listing = registryId
      ? await this.view<{ name: string; description: string; vault_id: string; shares_id: string | null; registered_at_ns: string } | null>(registryId, "get_company", { dao_id: treasury.daoAccountId }).catch(() => null)
      : null;
    return {
      registryId,
      daoAccountId: treasury.daoAccountId,
      vaultAccountId: treasury.vaultAccountId,
      sharesAccountId: shares?.dao_id === treasury.daoAccountId ? sharesAccountId : null,
      listing,
    };
  }

  /**
   * The directory that accepts this vault: each one takes only vaults made by
   * its own Nomos, so a company from an earlier Nomos lists in an earlier one.
   */
  private async registryFor(vaultAccountId: string): Promise<string | null> {
    const candidates = [this.config.registryId, ...(this.config.previousRegistryIds ?? [])].filter((id): id is string => Boolean(id));
    if (candidates.length <= 1) return candidates[0] ?? null;
    for (const registryId of candidates) {
      const factory = await this.memo<string | null>(`vault-factory:${registryId}`, 3_600_000, () =>
        this.near.viewFunction<string | null>(registryId, "vault_factory_id").catch(() => null));
      if (factory && vaultAccountId.endsWith(`.${factory}`)) return registryId;
    }
    return candidates[0]!;
  }

  /** A vote that lists the company in the public directory. */
  async registryProposal(organizationId: string, input: { name: string; description: string }) {
    const directory = await this.directory(organizationId);
    if (!directory.registryId) throw new OmniRolesError(409, "registry_disabled", "no public directory is configured");
    let kind: ReturnType<typeof registryProposalKind>;
    try {
      kind = registryProposalKind(directory.registryId, { vaultAccountId: directory.vaultAccountId, sharesAccountId: directory.sharesAccountId, name: input.name, description: input.description });
    } catch (error) {
      throw new OmniRolesError(400, "invalid_listing", error instanceof Error ? error.message : String(error));
    }
    const summary = describeRegistryProposal(kind, directory.registryId)!;
    return { receiverId: directory.daoAccountId, args: proposalOf(summary.title, kind), deposit: this.config.proposalBondYocto, title: summary.title, summary: [summary] };
  }

  // -------------------------------------------------------------------------
  // Sealed orders (contracts/sealed-orders)
  // -------------------------------------------------------------------------

  private requireSealed(): string {
    if (!this.config.sealedOrdersId) throw new OmniRolesError(409, "sealed_disabled", "sealed orders are not configured on this server");
    return this.config.sealedOrdersId;
  }

  /**
   * The company's sealed orders as the chain shows them (a hash each, what was filled, the
   * ciphertext of the terms), the roles they can fill through (those the contract is a member of),
   * the members' reading keys and the router allowance of the wallet.
   */
  async sealedOrders(organizationId: string) {
    const treasury = await this.requireTreasury(organizationId);
    const sealedId = this.config.sealedOrdersId ?? null;
    const base = { vaultAccountId: treasury.vaultAccountId, daoAccountId: treasury.daoAccountId, router: BASE_SEPOLIA_UNISWAP.router, tokenIn: BASE_SEPOLIA_UNISWAP.usdc, tokenOut: BASE_SEPOLIA_UNISWAP.weth, chainId: BASE_SEPOLIA_UNISWAP.chainId };
    if (!sealedId) return { ...base, enabled: false as const, sealedAccountId: null, roles: [], orders: [], readers: [], allowance: null };
    const [{ roles }, orders, readers, wallet] = await Promise.all([
      this.roles(organizationId),
      this.view<unknown[]>(sealedId, "orders", { vault: treasury.vaultAccountId, limit: 50 }).catch(() => []),
      this.view<Array<{ account: string; public_key: string }>>(sealedId, "readers", { vault: treasury.vaultAccountId }).catch(() => []),
      this.view<{ address: number[] | null } | null>(treasury.vaultAccountId, "get_wallet", { chain_id: BASE_SEPOLIA_UNISWAP.chainId }).catch(() => null),
    ]);
    let allowance: string | null = null;
    if (wallet?.address) {
      try {
        const client = chainClient(rpcUrls(BASE_SEPOLIA_UNISWAP.chainId));
        allowance = (await client.readContract({ address: BASE_SEPOLIA_UNISWAP.usdc, abi: erc20Abi, functionName: "allowance", args: [getAddress(hexOf(wallet.address)), BASE_SEPOLIA_UNISWAP.router] })).toString();
      } catch {
        allowance = null;
      }
    }
    const sealedRoles = roles
      .filter((role) => role.enabled && role.members.some((member) => member.member === sealedId))
      .map((role) => ({ name: role.name, budgets: role.budgets, agents: role.members.filter((member) => member.member !== sealedId).map((member) => member.member) }));
    return { ...base, enabled: true as const, sealedAccountId: sealedId, roles: sealedRoles, orders, readers, allowance };
  }

  /**
   * The DAO's order: one proposal to the sealed-orders contract, the router approval first when the
   * wallet's allowance is below `approveUsdc`, then the seal (a hash, and the terms encrypted for the
   * members' keys).
   */
  async sealedOrderProposal(organizationId: string, input: { role: string; commitment: string; slippageBps: number; terms: string | null; approveUsdc: string | null }) {
    const sealedId = this.requireSealed();
    const treasury = await this.requireTreasury(organizationId);
    let kind: ReturnType<typeof sealedOrderKind>;
    try {
      const fees = input.approveUsdc ? await chainClient(rpcUrls(BASE_SEPOLIA_UNISWAP.chainId)).estimateFeesPerGas() : null;
      kind = sealedOrderKind(
        sealedId,
        { vault: treasury.vaultAccountId, role: input.role, chainId: BASE_SEPOLIA_UNISWAP.chainId, commitment: input.commitment as Hex, slippageBps: input.slippageBps, terms: input.terms },
        input.approveUsdc && fees
          ? { vault: treasury.vaultAccountId, role: input.role, chainId: BASE_SEPOLIA_UNISWAP.chainId, token: BASE_SEPOLIA_UNISWAP.usdc, router: BASE_SEPOLIA_UNISWAP.router, amount: parseUnits(input.approveUsdc, 6), maxFeePerGas: (fees.maxFeePerGas ?? 1_000_000_000n) * 3n }
          : undefined,
      );
    } catch (error) {
      throw new OmniRolesError(400, "invalid_sealed", error instanceof Error ? error.message : String(error));
    }
    return this.sealedProposal(treasury, kind, sealedId);
  }

  async sealedCancelProposal(organizationId: string, id: number) {
    const sealedId = this.requireSealed();
    const treasury = await this.requireTreasury(organizationId);
    return this.sealedProposal(treasury, sealedCancelKind(sealedId, treasury.vaultAccountId, id), sealedId);
  }

  private sealedProposal(treasury: { daoAccountId: string }, kind: unknown, sealedId: string) {
    const summary = describeSealedProposal(kind, sealedId)!;
    return { receiverId: treasury.daoAccountId, args: proposalOf(summary.title, kind), deposit: this.config.proposalBondYocto, title: summary.title, summary: [summary] };
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

  /** The company wallet on its main chain, read from the vault; null before the wallet exists. */
  async companyWallet(organizationId: string): Promise<{ address: string; chainId: number; vaultAccountId: string } | null> {
    const treasury = await this.treasury(organizationId);
    if (!treasury) return null;
    const wallet = await this.view<{ address: number[] | null } | null>(treasury.vaultAccountId, "get_wallet", { chain_id: treasury.baseChainId });
    return wallet?.address ? { address: getAddress(hexOf(wallet.address)), chainId: treasury.baseChainId, vaultAccountId: treasury.vaultAccountId } : null;
  }

  async status(organizationId: string) {
    const treasury = await this.treasury(organizationId);
    if (!treasury) return { treasury: null, checks: [], wallet: null, dao: null, paused: false };
    // One wave: every read below is independent (the version list only needs code_source).
    const versions = this.view<string>(treasury.vaultAccountId, "code_source").catch(() => this.config.nomosId)
      .then(async (source) => ({ source, published: (await this.vaultVersions(source).catch(() => [])).map((version) => version.codeHash) }));
    const planned = this.plan(organizationId, treasury.daoAccountId.split(".")[0] ?? "company").catch(() => null);
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
    const plan = await planned;
    const expectedMembers = (plan?.council.map((member) => member.nearAccountId) ?? []).sort();
    const { source: codeSource, published } = await versions;
    const vaultCode = vaultAccount?.code_hash ?? "missing";
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
      {
        label: `Vault code is a version published on ${codeSource}`,
        expected: published.length ? published.join(" or ") : "a published version",
        actual: vaultCode,
        ok: published.includes(vaultCode),
      },
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
      solana: await this.solanaWallet(treasury.vaultAccountId),
      paused: Boolean(paused),
    };
  }

  // -------------------------------------------------------------------------
  // Proposals (signed by members in their wallet)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Holdings: what the company owns, per chain
  // -------------------------------------------------------------------------

  async holdings(organizationId: string) {
    const treasury = await this.requireTreasury(organizationId);
    return this.memo(`holdings:${treasury.vaultAccountId}`, 20_000, async () => {
      const chains: Array<{ chain: string; address: string; explorer: string; assets: Array<{ symbol: string; amount: string; where: string }> }> = [];
      const wallet = await this.view<{ address: number[] | null } | null>(treasury.vaultAccountId, "get_wallet", { chain_id: treasury.baseChainId }).catch(() => null);
      if (wallet?.address) {
        const address = getAddress(hexOf(wallet.address));
        const [balances, positions] = await Promise.all([
          this.chain.balances(address, PROFILE).catch(() => ({ eth: "0", tokens: [] as Array<{ symbol: string; amount: string }> })),
          this.chain.lendingPositions?.(address, PROFILE).catch(() => []) ?? Promise.resolve([]),
        ]);
        chains.push({
          chain: PROFILE.name,
          address,
          explorer: `https://sepolia.basescan.org/address/${address}`,
          assets: [
            ...(Number(balances.eth) > 0 ? [{ symbol: "ETH", amount: balances.eth, where: "wallet" }] : []),
            ...balances.tokens.filter((token) => Number(token.amount) > 0).map((token) => ({ symbol: token.symbol, amount: token.amount, where: "wallet" })),
            ...positions.map((position) => ({ symbol: position.symbol, amount: position.amount, where: `deposited on ${position.protocol}` })),
          ],
        });
      }
      const solana = await this.solanaWallet(treasury.vaultAccountId).catch(() => null);
      if (solana?.address) {
        const rpc = solanaRpc(this.config.solanaRpcUrl ?? SOLANA_DEVNET.rpcUrl);
        const assets: Array<{ symbol: string; amount: string; where: string }> = [];
        if (solana.sol && Number(solana.sol) > 0) assets.push({ symbol: "SOL", amount: solana.sol, where: "wallet" });
        for (const token of SOLANA_DEVNET.tokens.filter((item) => item.mint)) {
          const accounts = await rpc<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: string } } } } } }> }>(
            "getTokenAccountsByOwner", [solana.address, { mint: token.mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
          ).catch(() => ({ value: [] }));
          const amount = accounts.value.reduce((sum, item) => sum + Number(item.account.data.parsed.info.tokenAmount.uiAmountString), 0);
          if (amount > 0) assets.push({ symbol: token.symbol, amount: String(amount), where: "wallet" });
        }
        chains.push({ chain: solana.network, address: solana.address, explorer: `https://explorer.solana.com/address/${solana.address}?cluster=devnet`, assets });
      }
      // NEP-141 tokens held by the vault account itself, and by the agents' spending cards.
      const nearAssets = await this.nearTokenHoldings(organizationId, treasury.vaultAccountId).catch(() => []);
      if (nearAssets.length) {
        chains.push({ chain: "NEAR testnet", address: treasury.vaultAccountId, explorer: `https://testnet.nearblocks.io/address/${treasury.vaultAccountId}`, assets: nearAssets });
      }
      // Indicative dollar values: testnet assets priced as their mainnet counterparts.
      const prices = await usdPrices().catch(() => ({} as Record<string, number>));
      const valued = chains.map((chain) => {
        const assets = chain.assets.map((asset) => ({ ...asset, usd: usdValue(asset.symbol, asset.amount, prices) }));
        return { ...chain, assets, usd: assets.reduce((sum, asset) => sum + (asset.usd ?? 0), 0) };
      });
      return { chains: valued, totalUsd: valued.reduce((sum, chain) => sum + chain.usd, 0), pricedAt: new Date().toISOString(), indicative: true };
    });
  }

  /** Known NEP-141 balances of the vault account and of each agent's card (non-zero only). */
  private async nearTokenHoldings(organizationId: string, vaultAccountId: string) {
    const agents = await this.prisma.agent.findMany({ where: { organizationId, active: true } });
    const holders: Array<{ accountId: string; where: string }> = [{ accountId: vaultAccountId, where: "vault" }];
    for (const agent of agents) {
      if (!agent.nearAccountId) continue;
      try {
        holders.push({ accountId: cardAccountIdOf(agent.nearAccountId), where: `${agent.name}'s card` });
      } catch { /* agent account not made by Euthyna: no card */ }
    }
    const assets: Array<{ symbol: string; amount: string; where: string }> = [];
    for (const holder of holders) {
      for (const token of NEAR_TESTNET_TOKENS) {
        // A missing card account or an unregistered holder reads as zero.
        const raw = await this.near.viewFunction<string>(token.accountId, "ft_balance_of", { account_id: holder.accountId }).catch(() => "0");
        if (BigInt(raw || "0") > 0n) assets.push({ symbol: token.symbol, amount: formatUnits(BigInt(raw), token.decimals), where: holder.where });
      }
    }
    return assets;
  }

  // -------------------------------------------------------------------------
  // Vault versions (published on Nomos) and DAO-voted upgrades
  // -------------------------------------------------------------------------

  /** The vault's code against the versions published on Nomos. */
  async versions(organizationId: string) {
    const treasury = await this.requireTreasury(organizationId);
    this.forget(treasury.vaultAccountId);
    const [account, source] = await Promise.all([
      this.near.getAccount(treasury.vaultAccountId),
      this.near.viewFunction<string>(treasury.vaultAccountId, "code_source").catch(() => null),
    ]);
    // Versions come from where this vault fetches them (its Nomos, or another one the DAO voted).
    const nomosId = source ?? this.config.nomosId;
    const published = await this.near.viewFunction<Array<{ code_hash: string; size: number; notes: string; published_at_ns: string }>>(nomosId, "versions").catch(() => []);
    const current = account.code_hash;
    const latest = published.at(-1)?.code_hash ?? null;
    return {
      vaultAccountId: treasury.vaultAccountId,
      nomosId,
      current,
      latest,
      // Vaults made before Nomos cannot fetch code: they have no upgrade path.
      upgradable: source !== null,
      versions: published.map((version, index) => ({
        index: index + 1,
        codeHash: version.code_hash,
        size: version.size,
        notes: version.notes,
        publishedAt: new Date(Number(BigInt(version.published_at_ns) / 1_000_000n)).toISOString(),
        current: version.code_hash === current,
      })).reverse(),
    };
  }

  /**
   * A vote to move the vault to a published version. The relayer first tops the
   * vault up when the new code needs more storage than it holds.
   */
  async upgradeProposal(organizationId: string, codeHash: string) {
    const treasury = await this.requireTreasury(organizationId);
    const info = await this.versions(organizationId);
    if (!info.upgradable) throw new OmniRolesError(409, "not_upgradable", "this vault was created before Nomos and cannot be upgraded");
    const target = info.versions.find((version) => version.codeHash === codeHash);
    if (!target) throw new OmniRolesError(404, "unknown_version", `${codeHash} is not published on ${info.nomosId}`);
    if (target.current) throw new OmniRolesError(409, "already_current", "the vault already runs this version");
    const account = await this.near.getAccount(treasury.vaultAccountId);
    const currentSize = info.versions.find((version) => version.current)?.size ?? 0;
    const grow = BigInt(Math.max(0, target.size - currentSize)) * STORAGE_PRICE_PER_BYTE;
    const free = BigInt(account.amount) - BigInt(account.storage_usage ?? 0) * STORAGE_PRICE_PER_BYTE;
    const needed = grow + STORAGE_LOW_YOCTO;
    if (free < needed) {
      await this.near.executeActions(treasury.vaultAccountId, [{ type: "Transfer", depositYocto: (needed - free + STORAGE_TOP_UP_YOCTO).toString() }]);
    }
    const label = `version ${target.index}${target.notes ? ` (${target.notes})` : ""}`;
    return this.proposal(treasury, `Upgrade the vault to ${label}`, [{ method: "queue_rule_change", change: { Upgrade: { code_hash: codeHash } } }]);
  }

  async walletProposal(organizationId: string, chainId?: number, solana = false) {
    const treasury = await this.requireTreasury(organizationId);
    if (solana) return this.proposal(treasury, "Create the company wallet on Solana", [{ method: "request_solana_wallet" }]);
    const target = chainId ?? treasury.baseChainId;
    const calls: VaultCall[] = [{ method: "request_wallet", chainId: target }];
    return this.proposal(treasury, `Create the company wallet on ${chainName(target)}`, calls);
  }

  /** Sponsored gas (EIP-7702): one vote lets the wallet delegate to EuthynaExecutor, or stops it. */
  async sponsorProposal(organizationId: string, enable: boolean) {
    const treasury = await this.requireTreasury(organizationId);
    const chainId = treasury.baseChainId;
    const executor = enable ? Array.from(hexToBytes(EUTHYNA_EXECUTOR as Hex)) : null;
    const title = enable ? `Sponsor network fees on ${chainName(chainId)}` : `Stop sponsoring network fees on ${chainName(chainId)}`;
    return this.proposal(treasury, title, [{ method: "queue_rule_change", change: { SetEvmExecutor: { chain_id: chainId, executor } } }]);
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

  async suppliers(organizationId: string) {
    const treasury = await this.requireTreasury(organizationId);
    return { entries: await this.near.viewFunction<Array<{ address: number[]; label: string }>>(treasury.vaultAccountId, "get_address_list", { list: "suppliers" }) };
  }

  async suppliersProposal(organizationId: string, input: { entries: Array<{ address: string; label: string }>; migrate?: boolean | undefined }) {
    const treasury = await this.requireTreasury(organizationId);
    let entries = input.entries;
    if (input.migrate) {
      const current = await this.suppliers(organizationId);
      if (current.entries.length) throw new OmniRolesError(409, "already_migrated", "The on-chain suppliers list is already populated");
      const wallets = await this.prisma.supplierWallet.findMany({ where: { organizationId, chainId: PROFILE.chainId, active: true, supplier: { active: true } }, include: { supplier: true } });
      entries = wallets.map((w) => ({ address: w.address, label: w.supplier.name }));
    }
    const unique = [...new Map(entries.map((e) => [e.address.toLowerCase(), e])).values()];
    if (!unique.length || unique.length > 256) throw new OmniRolesError(400, "invalid_list", "Choose 1 to 256 suppliers");
    const calls = unique.map((e) => {
      if ([...e.label].length > 64) throw new OmniRolesError(400, "invalid_label", "Supplier labels must contain at most 64 characters");
      return { method: "queue_rule_change" as const, change: { AddListAddress: { list: "suppliers", address: Array.from(hexToBytes(e.address as Hex)), label: e.label } } };
    });
    if (input.migrate) {
      return this.proposal(treasury, "Move existing suppliers on chain", [{ method: "queue_rule_change", change: { AddListAddresses: { list: "suppliers", entries: calls.map((c) => ({address:c.change.AddListAddress.address,label:c.change.AddListAddress.label})) } } }]);
    }
    return this.proposal(treasury, "Add supplier", calls);
  }

  async roleProposal(organizationId: string, draft: RoleDraft) {
    const treasury = await this.requireTreasury(organizationId);
    // A swap block that allows sealed orders makes contracts/sealed-orders a member of the role:
    // fills then go through the same router, pair, recipient and budget as the agents' swaps.
    // An edited role that already has it keeps its membership as it is.
    if (draft.blocks.some((block) => block.kind === "swap" && block.sealedOrders)) {
      const sealedId = this.requireSealed();
      const membership = await this.view<{ active?: boolean } | null>(treasury.vaultAccountId, "get_membership", { role: draft.name, member: sealedId }).catch(() => null);
      draft = withSealedOrdersMember(draft, sealedId, Boolean(membership?.active));
    }
    for (const block of draft.blocks) {
      if (block.kind === "share-revenue" && block.sharesAccountId !== this.sharesAccountOf(treasury)) {
        throw new OmniRolesError(400, "invalid_role", `revenue can only go to this company's shares contract, ${this.sharesAccountOf(treasury)}`);
      }
    }
    // NEAR permissions: only vaults on the NEAR-transfer version know them.
    // Only "method not found" means an older vault; any other error stops here.
    const nearSupported = await this.view<unknown[]>(treasury.vaultAccountId, "get_near_permissions", { role: draft.name }).then(() => true, (error: unknown) => {
      if (/MethodNotFound|MethodResolveError/.test(String(error))) return false;
      throw error;
    });
    if (draft.blocks.some((block) => block.kind === "near-transfer") && !nearSupported) {
      throw new OmniRolesError(400, "invalid_role", "this vault cannot send NEAR tokens yet: vote the vault upgrade first");
    }
    // A role saved without a NEAR block always clears NEAR rights on vaults that have them:
    // an earlier vote still in the veto queue may add some after this one is drafted.
    draft = { ...draft, clearNearPermissions: nearSupported };
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

  /** Fire an agent: one vote removes it from every job it holds. */
  async fireProposal(organizationId: string, member: string) {
    const treasury = await this.requireTreasury(organizationId);
    const { roles } = await this.roles(organizationId);
    const held = roles.filter((role) => role.members.some((item) => item.member === member));
    if (held.length === 0) throw new OmniRolesError(409, "not_hired", `${member} holds no job`);
    const calls = held.map((role) => ({ method: "queue_rule_change" as const, change: { RevokeMembership: { role: role.name, member } } as RuleChange }));
    return this.proposal(treasury, `Fire ${member} (${held.map((role) => role.name).join(", ")})`, calls, await this.labels(organizationId));
  }

  /** Change a job's budget: same period, new amount, what is left resets to it. */
  async budgetProposal(organizationId: string, input: { key: string; amount: string }) {
    const treasury = await this.requireTreasury(organizationId);
    const rules = await this.view<QueuedRule[]>(treasury.vaultAccountId, "list_rule_changes", { before: null, limit: 50 });
    const budgets = budgetsOf(rules.filter((rule) => rule.state === "Executed").reverse().map((rule) => rule.change), PROFILE);
    const key = input.key.toLowerCase();
    const info = budgets[key];
    const allowance = await this.view<{ period_ns: number } | null>(treasury.vaultAccountId, "get_allowance", { key: Array.from(Buffer.from(key.slice(2), "hex")) });
    if (!info || !allowance) throw new OmniRolesError(404, "budget_not_found", "no active budget with this key");
    let amount: bigint;
    try {
      amount = parseUnits(input.amount, info.token?.decimals ?? 0);
    } catch {
      throw new OmniRolesError(400, "invalid_amount", `${input.amount} is not an amount`);
    }
    if (amount <= 0n) throw new OmniRolesError(400, "invalid_amount", "to stop a job, fire the agent or pause the company instead");
    const change: RuleChange = {
      SetAllowance: {
        key: Array.from(Buffer.from(key.slice(2), "hex")),
        balance: amount.toString(),
        refill: amount.toString(),
        max_refill: amount.toString(),
        period_ns: allowance.period_ns,
      },
    };
    const days = allowance.period_ns / 86_400_000_000_000;
    const title = `Set the ${info.label} budget to ${input.amount} ${info.token?.symbol ?? ""} every ${days} day${days === 1 ? "" : "s"}`.replace(/\s+/g, " ");
    return this.proposal(treasury, title, [{ method: "queue_rule_change", change }], await this.labels(organizationId));
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
    const [lastId, policy, rules, paused, daoTransactions, lockedShares, baseWallet] = await Promise.all([
      this.view<number>(treasury.daoAccountId, "get_last_proposal_id"),
      this.view<{ default_vote_policy: { threshold: unknown }; roles: Array<{ kind: unknown }>; proposal_period: string }>(treasury.daoAccountId, "get_policy"),
      this.view<QueuedRule[]>(treasury.vaultAccountId, "list_rule_changes", { before: null, limit: 50 }),
      this.view<boolean>(treasury.vaultAccountId, "is_paused"),
      this.view<DaoOperation[]>(treasury.vaultAccountId, "list_dao_transactions", { limit: 50 }).catch(() => [] as DaoOperation[]),
      this.view<string>(treasury.daoAccountId, "delegation_total_supply").catch(() => "0"),
      this.view<{ address: number[] | null } | null>(treasury.vaultAccountId, "get_wallet", { chain_id: treasury.baseChainId }).catch(() => null),
    ]);
    const companyWallet = baseWallet?.address ? getAddress(hexOf(baseWallet.address)) : null;
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
                const sharesChange = describeSharesProposal(proposal.kind, this.sharesAccountOf(treasury)) ?? describeProceedsProposal(proposal.kind, companyWallet) ?? (describeRegistryProposal(proposal.kind, this.config.registryId ?? null) ?? (this.config.previousRegistryIds ?? []).map((id) => describeRegistryProposal(proposal.kind, id)).find(Boolean) ?? null) ?? describeSealedProposal(proposal.kind, this.config.sealedOrdersId ?? null);
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

  /** Activate rule changes whose delay has passed (permissionless on chain; Euthyna pays the gas). */
  async activateReadyRules(organizationId: string): Promise<string[]> {
    return (await this.activateDue(organizationId)).hashes;
  }

  /**
   * One vault's due work, and when it next has something due: the earliest
   * veto window still running, or null when nothing is queued.
   */
  private async activateDue(organizationId: string): Promise<{ hashes: string[]; nextDueMs: number | null }> {
    const treasury = await this.requireTreasury(organizationId);
    // Fresh from the chain, never the screens' cache: a stale list would miss a rule or run one twice.
    const rules = await this.near.viewFunction<QueuedRule[]>(treasury.vaultAccountId, "list_rule_changes", { before: null, limit: 50 });
    this.noteRules(treasury.vaultAccountId, rules);
    const now = nowNs();
    const queued = rules.filter((rule) => rule.state === "Queued" && now <= BigInt(rule.expires_at_ns));
    const ready = queued
      .filter((rule) => BigInt(rule.execute_after_ns) <= now)
      // Oldest first: a role must exist before its memberships.
      .reverse();
    // Storage pays for agent operations too: checked every 10 minutes, and before any write here.
    const lastStorageCheck = this.storageCheckedAt.get(treasury.vaultAccountId) ?? 0;
    if (ready.length || Date.now() - lastStorageCheck > STORAGE_CHECK_EVERY_MS) {
      await this.keepStorageFunded(treasury.vaultAccountId);
      this.storageCheckedAt.set(treasury.vaultAccountId, Date.now());
    }
    const hashes: string[] = [];
    const retries: bigint[] = [];
    for (const rule of ready) {
      // A rule the vault refused (a role still busy: ERR_ROLE_IN_USE) is not sent again on every
      // pass: each try is a failed transaction, paid in gas, that also crowds the vault's history.
      const key = `${treasury.vaultAccountId}:${hexOf(rule.queue_id)}`;
      const refused = this.refusedRules.get(key);
      if (refused && refused.retryAt > Date.now()) {
        retries.push(BigInt(refused.retryAt) * 1_000_000n);
        continue;
      }
      // An upgrade fetches and deploys ~800 KB of code: give it the full 300 Tgas.
      const gas = rule.change && typeof rule.change === "object" && "Upgrade" in rule.change ? "300000000000000" : "100000000000000";
      // One rule the vault refuses for now (a budget still reserved by an unsettled operation:
      // ERR_ALLOWANCE_IN_USE, ERR_ROLE_IN_USE) must not hold back the others: it is tried again next round.
      try {
        hashes.push(await this.near.callFunction(treasury.vaultAccountId, "execute_rule_change", { queue_id: rule.queue_id }, gas, "0"));
        this.refusedRules.delete(key);
      } catch (error) {
        const tries = (refused?.tries ?? 0) + 1;
        const retryAt = Date.now() + Math.min(REFUSED_RULE_MAX_WAIT_MS, REFUSED_RULE_FIRST_WAIT_MS * 2 ** (tries - 1));
        this.refusedRules.set(key, { tries, retryAt });
        retries.push(BigInt(retryAt) * 1_000_000n);
        console.warn(`rule ${Object.keys(rule.change ?? {})[0] ?? "change"} on ${treasury.vaultAccountId} not applied yet: ${String(error).match(/ERR_[A-Z_]+/)?.[0] ?? String(error).slice(0, 120)}`);
      }
    }
    // A rule the keeper just applied may change what the vault pays or runs: read it again.
    if (hashes.length) this.ruleFacts.delete(treasury.vaultAccountId);
    const dao = await this.startDaoTransactions(organizationId, treasury);
    hashes.push(...dao.hashes);
    const orders = await this.runStandingOrders(treasury.vaultAccountId);
    hashes.push(...orders.hashes);
    const follow = await this.followBankSigner(treasury.vaultAccountId);
    hashes.push(...follow.hashes);
    // A vault that pays IBANs: an agent's payout queues its EURC transfer when the enclave answers,
    // without any call to this server. Read such a vault every minute so the transfer starts at once.
    const banking = await this.ruleFact<unknown>(treasury.vaultAccountId, "get_bank_config", () => this.near.viewFunction<unknown>(treasury.vaultAccountId, "get_bank_config", {}).catch(() => null));
    if (hashes.length) this.forget(treasury.vaultAccountId);
    const waitingNs = [
      ...queued.filter((rule) => BigInt(rule.execute_after_ns) > now).map((rule) => BigInt(rule.execute_after_ns)),
      ...dao.nextDueNs,
      ...orders.nextDueNs,
      ...follow.nextDueNs,
      ...(banking ? [nowNs() + BANK_RECHECK_NS] : []),
      ...retries,
    ];
    const nextDueMs = waitingNs.length ? Number(waitingNs.reduce((a, b) => (a < b ? a : b)) / 1_000_000n) : null;
    return { hashes, nextDueMs };
  }

  /** The rule list moved (a rule queued, applied, vetoed): forget what rules decide. */
  private noteRules(vaultAccountId: string, rules: QueuedRule[]): void {
    const fingerprint = rules.map((rule) => `${hexOf(rule.queue_id)}:${rule.state}`).join(",");
    if (this.ruleFacts.get(vaultAccountId)?.fingerprint !== fingerprint) this.ruleFacts.set(vaultAccountId, { fingerprint, values: new Map() });
  }

  /** A read that only a rule changes: from the last read while the rule list has not moved. */
  private async ruleFact<T>(vaultAccountId: string, method: string, read: () => Promise<T>): Promise<T> {
    const facts = this.ruleFacts.get(vaultAccountId) ?? { fingerprint: "", values: new Map() };
    this.ruleFacts.set(vaultAccountId, facts);
    const kept = facts.values.get(method);
    if (kept && Date.now() - kept.readAt < RULE_FACTS_TTL_MS) return kept.value as T;
    const value = await read();
    facts.values.set(method, { value, readAt: Date.now() });
    return value;
  }

  /**
   * Payroll and other standing orders the members voted: run the one that is due (anyone may; the
   * vault pays exactly the voted beneficiary and amount). One at a time: a vault has one euro payout
   * in flight, so the next waits for the enclave's answer.
   */
  private async runStandingOrders(vaultAccountId: string): Promise<{ hashes: string[]; nextDueNs: bigint[] }> {
    type Order = { id: number; next_at_ns: string; runs?: number };
    // Kept between passes: an order changes only by a vote or by being run (then read again).
    const orders = await this.ruleFact<Order[] | null>(vaultAccountId, "list_standing_orders", () => this.near.viewFunction<Order[]>(vaultAccountId, "list_standing_orders", {}).catch(() => null));
    if (!orders?.length) return { hashes: [], nextDueNs: [] };
    const now = nowNs();
    const later = orders.filter((order) => BigInt(order.next_at_ns) > now).map((order) => BigInt(order.next_at_ns));
    const due = orders.filter((order) => BigInt(order.next_at_ns) <= now);
    if (!due.length) return { hashes: [], nextDueNs: later };
    // A refused payout gives the order back with the same date: without this, it would be run
    // again on every pass (a failed payout, and a call to the enclave, every few seconds).
    const failures = await this.standingOrderFailures(vaultAccountId);
    const waits: bigint[] = [];
    const runnable = due.find((order) => {
      const failed = failures.get(`SO${order.id}-${(order.runs ?? 0) + 1}`) ?? [];
      if (failed.length >= STANDING_ORDER_ATTEMPTS) return false;
      if (!failed.length) return true;
      const retryAt = failed[failed.length - 1]! + STANDING_ORDER_BACKOFF_NS * 2n ** BigInt(failed.length - 1);
      if (retryAt <= now) return true;
      waits.push(retryAt);
      return false;
    });
    if (!runnable) return { hashes: [], nextDueNs: [...waits, ...later] };
    try {
      const hash = await this.near.callFunction(vaultAccountId, "run_standing_order", { id: runnable.id }, "250000000000000", "0");
      this.ruleFacts.get(vaultAccountId)?.values.delete("list_standing_orders");
      console.log(JSON.stringify({ event: "omniroles.standing_order_run", vaultAccountId, id: runnable.id, hash }));
      return { hashes: [hash], nextDueNs: [now + BUSY_RECHECK_NS, ...waits, ...later] };
    } catch (error) {
      // Another payout in flight (ERR_BANK_PAYOUT_PENDING) or the bank not set up yet: next round.
      console.warn(`standing order ${runnable.id} on ${vaultAccountId} not run yet: ${String(error).match(/ERR_[A-Z_]+|BeneficiaryNotAllowed/)?.[0] ?? String(error).slice(0, 120)}`);
      return { hashes: [], nextDueNs: [now + BUSY_RECHECK_NS, ...waits, ...later] };
    }
  }

  /**
   * A vault that follows its enclave project: when the project's active version is new to the
   * vault, ask the vault to queue it (`follow_bank_signer`, open to anyone). The vault queues it
   * as an ordinary rule: this job applies it once the veto window is over, like any vote.
   */
  private async followBankSigner(vaultAccountId: string): Promise<{ hashes: string[]; nextDueNs: bigint[] }> {
    type Source = { project: string; follow: boolean; last_queued: string | null } | null;
    const source = await this.ruleFact<Source>(vaultAccountId, "get_bank_signer_source", () => this.near.viewFunction<Source>(vaultAccountId, "get_bank_signer_source", {}).catch(() => null));
    if (!source?.follow) return { hashes: [], nextDueNs: [] };
    const recheck = nowNs() + FOLLOW_RECHECK_NS;
    // The project's versions change rarely (a release): look once an hour.
    if (Date.now() - (this.followCheckedAt.get(vaultAccountId) ?? 0) < Number(FOLLOW_RECHECK_NS / 1_000_000n)) return { hashes: [], nextDueNs: [] };
    this.followCheckedAt.set(vaultAccountId, Date.now());
    const config = await this.near.viewFunction<{ outlayer_id: string; signer_hash: string } | null>(vaultAccountId, "get_bank_config", {}).catch(() => null);
    const project = config ? await this.near.viewFunction<{ active_version?: string } | null>(config.outlayer_id, "get_project", { project_id: source.project }).catch(() => null) : null;
    const active = project?.active_version?.toLowerCase();
    if (!config || !active || active === config.signer_hash.toLowerCase() || active === source.last_queued) return { hashes: [], nextDueNs: [recheck] };
    try {
      const hash = await this.near.callFunction(vaultAccountId, "follow_bank_signer", {}, "80000000000000", "0");
      console.log(JSON.stringify({ event: "omniroles.bank_signer_followed", vaultAccountId, version: active, hash }));
      this.ruleFacts.delete(vaultAccountId);
      return { hashes: [hash], nextDueNs: [nowNs() + BUSY_RECHECK_NS] };
    } catch (error) {
      console.warn(`bank signer of ${vaultAccountId} not followed yet: ${String(error).match(/ERR_[A-Z_]+/)?.[0] ?? String(error).slice(0, 120)}`);
      return { hashes: [], nextDueNs: [recheck] };
    }
  }

  /** The failed payouts of recent standing-order runs, by reference ("SO3-1"), oldest first. */
  private async standingOrderFailures(vaultAccountId: string): Promise<Map<string, bigint[]>> {
    const failures = new Map<string, bigint[]>();
    const count = await this.near.viewFunction<number>(vaultAccountId, "count_bank_payouts", {}).catch(() => 0);
    if (!count) return failures;
    const payouts = await this.near.viewFunction<Array<{ reference: string; state: string; created_at_ns: string }>>(
      vaultAccountId, "list_bank_payouts", { from_index: Math.max(0, count - 30), limit: 30 },
    ).catch(() => []);
    for (const payout of payouts) {
      if (payout.state !== "Failed" || !/^SO\d+-\d+$/.test(payout.reference)) continue;
      failures.set(payout.reference, [...(failures.get(payout.reference) ?? []), BigInt(payout.created_at_ns)]);
    }
    return failures;
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
  private async startDaoTransactions(organizationId: string, treasury: { vaultAccountId: string }): Promise<{ hashes: string[]; nextDueNs: bigint[] }> {
    const transactions = await this.near.viewFunction<DaoOperation[]>(treasury.vaultAccountId, "list_dao_transactions", { limit: 50 }).catch(() => null);
    if (!transactions) return { hashes: [], nextDueNs: [] }; // vault deployed before DAO transactions
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
    // Voted transactions still in their veto window, or waiting for the chain's wallet to be free.
    const nextDueNs = transactions
      .filter((item) => item.state === "Scheduled" && item.execute_after_ns !== null && now <= BigInt(item.expires_at_ns))
      .map((item) => (BigInt(item.execute_after_ns!) > now ? BigInt(item.execute_after_ns!) : now + BUSY_RECHECK_NS));
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
    return { hashes, nextDueNs };
  }

  /**
   * The background job (every few seconds). One pass at a time, in the RPC
   * background lane so screens go first, and only the vaults that are due:
   * a vault with a veto window running is checked when it ends; an idle
   * vault every minute (a new rule waits a whole veto window, at least
   * minutes, before it can run); a vault that errors, later.
   */
  async activateAllReadyRules(): Promise<{ checked: number; skipped: boolean }> {
    if (this.activationRunning) return { checked: 0, skipped: true };
    this.activationRunning = true;
    try {
      return await inBackground(async () => {
        const treasuries = await this.prisma.treasury.findMany({ select: { organizationId: true, vaultAccountId: true } });
        const now = Date.now();
        const due = treasuries.filter((treasury) => (this.nextActivationCheck.get(treasury.vaultAccountId) ?? 0) <= now);
        let index = 0;
        const lane = async () => {
          while (index < due.length) {
            const treasury = due[index++]!;
            try {
              const { nextDueMs } = await this.activateDue(treasury.organizationId);
              // A little after the window ends: the chain's clock decides, not ours.
              const next = nextDueMs === null ? Date.now() + IDLE_RECHECK_MS : Math.min(nextDueMs + DUE_MARGIN_MS, Date.now() + IDLE_RECHECK_MS);
              this.nextActivationCheck.set(treasury.vaultAccountId, Math.max(next, Date.now() + 1_000));
            } catch (error) {
              const missing = /CodeDoesNotExist|MethodNotFound|does not exist|Cannot find contract code/i.test(String(error));
              this.nextActivationCheck.set(treasury.vaultAccountId, Date.now() + (missing ? BROKEN_RECHECK_MS : ERROR_RECHECK_MS));
              console.error(`rule activation failed for ${treasury.vaultAccountId}:`, error);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(ACTIVATION_LANES, due.length) }, lane));
        return { checked: due.length, skipped: false };
      });
    } finally {
      this.activationRunning = false;
    }
  }

  // -------------------------------------------------------------------------
  // Roles, agents' dry runs and activity
  // -------------------------------------------------------------------------

  /** Euro payouts: the vault's bank config, voted IBANs, each role's permission and the payouts made. */
  async bank(organizationId: string) {
    const treasury = await this.requireTreasury(organizationId);
    const vault = treasury.vaultAccountId;
    const config = await this.view<BankConfig | null>(vault, "get_bank_config").catch((error: unknown) => {
      if (/MethodNotFound|MethodResolveError/.test(String(error))) return undefined;
      throw error;
    });
    if (config === undefined) return { supported: false as const, deployable: Boolean(this.config.bankSigner), config: null, boxKey: null, readers: [], beneficiaries: [], roles: [], payouts: [] };
    const account = await this.prisma.bankAccount.findFirst({ where: { organizationId, provider: "noah" } });
    const [beneficiaries, count, rolesView, boxKey, readers, signerSource] = await Promise.all([
      this.view<SealedBeneficiary[]>(vault, "list_bank_beneficiaries").catch(() => [] as SealedBeneficiary[]),
      this.view<number>(vault, "count_bank_payouts"),
      this.roles(organizationId),
      this.view<string | null>(vault, "get_bank_box_key").catch(() => null),
      // The members' reading keys (registered for sealed orders): beneficiaries are sealed to them too.
      this.config.sealedOrdersId
        ? this.view<Array<{ account: string; public_key: string }>>(this.config.sealedOrdersId, "readers", { vault }).catch(() => [])
        : Promise.resolve([] as Array<{ account: string; public_key: string }>),
      this.view<{ project: string; follow: boolean; last_queued: string | null } | null>(vault, "get_bank_signer_source").catch(() => null),
    ]);
    const payouts = count ? await this.view<BankPayout[]>(vault, "list_bank_payouts", { from_index: Math.max(0, count - 50), limit: 50 }) : [];
    const agents = await this.prisma.agent.findMany({ where: { organizationId } });
    const agentByAccount = new Map(agents.map((agent) => [agent.nearAccountId, agent.name]));
    const roles = await Promise.all(rolesView.roles.map(async (role) => {
      const permission = await this.view<BankPermission | null>(vault, "get_bank_permission", { role: role.name });
      const key = permission ? hexOf(permission.allowance).toLowerCase() : null;
      return {
        role: role.name,
        budgets: role.budgets,
        permission: permission ? { budget: key, budgetLabel: role.budgets.find((budget) => budget.key === key)?.label ?? null, maxPerPayout: permission.max_per_payout } : null,
      };
    }));
    return {
      supported: true as const,
      deployable: Boolean(this.config.bankSigner),
      // A vault that follows its enclave project is never "outdated": new versions come by themselves.
      config: config ? { ...config, token: hexOf(config.token), configured: signerSource?.follow ? true : this.config.bankSigner ? config.signer_hash === this.config.bankSigner.signerHash : null } : null,
      signerSource: signerSource
        ? { project: signerSource.project, follow: signerSource.follow, pendingVersion: signerSource.last_queued && signerSource.last_queued !== config?.signer_hash ? signerSource.last_queued : null }
        : null,
      signerProject: this.config.bankSigner?.project ?? null,
      customerId: account?.customerId ?? null,
      boxKey,
      readers: readers.map((reader) => ({ account: reader.account, publicKey: reader.public_key })),
      sealedOrdersId: this.config.sealedOrdersId ?? null,
      // No IBAN here: the server never sees one. Members open `sealedForMembers` in their browser.
      beneficiaries: beneficiaries.map((entry) => ({ id: entry.id, label: entry.label, commitment: entry.commitment, sealedForMembers: entry.sealed_for_members })),
      roles,
      payouts: [...payouts].reverse().map((payout) => ({
        opId: hexOf(payout.op_id),
        at: new Date(Number(BigInt(payout.created_at_ns) / NANOS_PER_MS)).toISOString(),
        actor: agentByAccount.get(payout.member) ?? payout.member,
        role: payout.role,
        beneficiary: { id: payout.beneficiary_id, label: payout.beneficiary_label },
        amount: payout.amount,
        fiatAmount: payout.fiat_amount,
        reference: payout.reference,
        state: payout.state,
        ruleId: payout.rule_id,
        transferOpId: payout.transfer_op_id ? hexOf(payout.transfer_op_id) : null,
        error: payout.error,
      })),
    };
  }

  /**
   * Vote a beneficiary in, sealed in the member's browser (packages/sdk/src/bank-private.ts): this
   * server receives the commitment and the two envelopes, never the IBAN or the holder.
   */
  async bankBeneficiaryProposal(organizationId: string, input: { label: string; commitment: string; sealedForSigner: string; sealedForMembers: string }) {
    const treasury = await this.requireTreasury(organizationId);
    if (/[A-Z]{2}\d{2}[A-Z0-9]{11,30}/i.test(input.label.replace(/\s+/g, ""))) throw new OmniRolesError(400, "label_is_iban", "The label is public: never an IBAN");
    return this.proposal(treasury, "Add a sealed bank beneficiary", [{
      method: "queue_rule_change",
      change: { AddSealedBankBeneficiary: { label: input.label.trim(), commitment: input.commitment.toLowerCase(), sealed_for_signer: input.sealedForSigner, sealed_for_members: input.sealedForMembers } },
    }]);
  }

  /** Payroll, rent, a retainer: the members vote once, the vault pays on every date. */
  async standingOrderProposal(organizationId: string, input: { beneficiaryId: number; amount: string; firstAt: string; periodDays: number; count: number | null; label: string; remove?: number | undefined }) {
    const treasury = await this.requireTreasury(organizationId);
    if (input.remove) return this.proposal(treasury, `Stop standing order #${input.remove}`, [{ method: "queue_rule_change", change: { RemoveStandingOrder: { id: input.remove } } }]);
    const first = Date.parse(input.firstAt);
    if (!Number.isFinite(first)) throw new OmniRolesError(400, "invalid_date", "Choose the first payment date");
    if (!/^\d+$/.test(input.amount) || BigInt(input.amount) === 0n) throw new OmniRolesError(400, "invalid_amount", "The amount must be positive");
    const periodNs = BigInt(Math.round(input.periodDays * 86_400_000)) * 1_000_000n;
    const minutes = Math.round(input.periodDays * 1440);
    const every = minutes === 1440 ? "every day" : minutes % 1440 === 0 ? `every ${minutes / 1440} days` : `every ${minutes} minutes`;
    return this.proposal(treasury, `Pay beneficiary #${input.beneficiaryId} ${every}`, [{
      method: "queue_rule_change",
      change: { AddStandingOrder: { beneficiary_id: input.beneficiaryId, amount: input.amount, first_at_ns: (BigInt(first) * 1_000_000n).toString(), period_ns: periodNs.toString(), count: input.count, label: input.label.trim() } },
    }]);
  }

  async standingOrders(organizationId: string) {
    const treasury = await this.requireTreasury(organizationId);
    const orders = await this.view<Array<{ id: number; beneficiary_id: number; amount: string; next_at_ns: string; period_ns: string; remaining: number | null; runs: number; label: string }>>(treasury.vaultAccountId, "list_standing_orders").catch(() => []);
    return {
      orders: orders.map((order) => ({
        id: order.id, beneficiaryId: order.beneficiary_id, amount: order.amount, label: order.label, runs: order.runs, remaining: order.remaining,
        nextAt: new Date(Number(BigInt(order.next_at_ns) / NANOS_PER_MS)).toISOString(),
        periodDays: Number(BigInt(order.period_ns) / 1_000_000n) / 86_400_000,
      })),
    };
  }

  async bankBeneficiaryRemoval(organizationId: string, id: number) {
    const treasury = await this.requireTreasury(organizationId);
    return this.proposal(treasury, `Remove bank beneficiary #${id}`, [{ method: "queue_rule_change", change: { RemoveSealedBankBeneficiary: { id } } }]);
  }

  /**
   * Let a role pay the voted IBANs from one of its EURC budgets, up to a ceiling per payout; or,
   * with `newBudget`, from a euro budget created for it (so much per period, refilled).
   */
  async bankPermissionProposal(organizationId: string, input: { role: string; budget: string | null; maxPerPayout: string | null; newBudget?: { amount: string; periodDays: number } | undefined }) {
    const treasury = await this.requireTreasury(organizationId);
    const roles = await this.roles(organizationId);
    const role = roles.roles.find((item) => item.name === input.role);
    if (!role) throw new OmniRolesError(404, "unknown_role", "No such role");
    const { maxPerPayout } = input;
    if (!maxPerPayout) {
      return this.proposal(treasury, `Remove euro payouts from ${input.role}`, [{ method: "queue_rule_change", change: { SetBankPermission: { role: input.role, permission: null } } }], {});
    }
    if (!/^\d+$/.test(maxPerPayout) || BigInt(maxPerPayout) === 0n) throw new OmniRolesError(400, "invalid_ceiling", "The ceiling per payout must be a positive amount");
    const calls: VaultCall[] = [];
    let allowance: number[];
    if (input.newBudget) {
      if (!/^\d+$/.test(input.newBudget.amount) || BigInt(input.newBudget.amount) === 0n) throw new OmniRolesError(400, "invalid_budget", "The euro budget must be a positive amount");
      allowance = euroPayoutBudgetKey(input.role);
      calls.push({ method: "queue_rule_change", change: { SetAllowance: { key: allowance, balance: input.newBudget.amount, refill: input.newBudget.amount, max_refill: input.newBudget.amount, period_ns: Math.max(0, Math.round(input.newBudget.periodDays * 86_400_000_000_000)) } } });
    } else {
      const budget = input.budget ? role.budgets.find((item) => item.key === input.budget!.toLowerCase()) : undefined;
      if (!budget) throw new OmniRolesError(400, "unknown_budget", "Choose one of the role's budgets");
      if (budget.token !== "EURC") throw new OmniRolesError(400, "budget_token", "Euro payouts are charged to an EURC budget");
      allowance = Array.from(hexToBytes(budget.key as Hex));
    }
    calls.push({ method: "queue_rule_change", change: { SetBankPermission: { role: input.role, permission: { allowance, max_per_payout: maxPerPayout } } } });
    return this.proposal(treasury, `Let ${input.role} pay voted IBANs in euros`, calls);
  }

  /** Point the vault at the deployed bank signer and the company's account at the partner. */
  async bankConfigProposal(organizationId: string) {
    const treasury = await this.requireTreasury(organizationId);
    const signer = this.config.bankSigner;
    if (!signer) throw new OmniRolesError(404, "no_bank_signer", "No bank signer is deployed for this console");
    const account = await this.prisma.bankAccount.findFirst({ where: { organizationId, provider: "noah" } });
    if (!account) throw new OmniRolesError(409, "no_bank_account", "Open the company's euro account first");
    const token = PROFILE.tokens.find((item) => item.symbol === "EURC");
    if (!token || account.chainId !== PROFILE.chainId) throw new OmniRolesError(409, "no_euro_token", "No euro token on this chain");
    const config: BankConfig = {
      outlayer_id: signer.outlayerId,
      signer_url: signer.signerUrl,
      signer_hash: signer.signerHash,
      secrets_owner: signer.secretsOwner,
      secrets_profile: signer.secretsProfile,
      customer_id: account.customerId,
      network: account.network,
      crypto: account.cryptoCurrency,
      chain_id: account.chainId,
      token: Array.from(hexToBytes(token.address as Hex)),
      decimals: token.decimals,
      ...BANK_TRANSFER_GAS,
    };
    return this.proposal(treasury, "Enable euro payouts through the bank signer", [
      { method: "queue_rule_change", change: { SetBankConfig: { config } } },
      // Beneficiaries are sealed to this enclave's key; voting it also erases any IBAN kept in clear.
      { method: "queue_rule_change", change: { SetBankBoxKey: { key: signer.boxKey } } },
      // Fixes to the enclave then arrive by themselves, each after the veto window (members can veto).
      ...(signer.project ? [{ method: "queue_rule_change" as const, change: { SetBankSignerSource: { project: signer.project, follow: true } } }] : []),
    ]);
  }

  /** Follow the enclave project's versions (each after the veto window), or vote each one. */
  async bankSignerSourceProposal(organizationId: string, follow: boolean) {
    const treasury = await this.requireTreasury(organizationId);
    const project = this.config.bankSigner?.project;
    if (!project) throw new OmniRolesError(404, "no_signer_project", "This console's bank signer is not published as an OutLayer project");
    return this.proposal(treasury, follow ? "Take bank enclave updates after the veto window" : "Vote each bank enclave update", [
      { method: "queue_rule_change", change: { SetBankSignerSource: { project, follow } } },
    ]);
  }

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
    const memberships = new Map<string, { member: string; kind: string; service?: string }[]>();
    for (const change of executed) {
      if ("GrantMembership" in change) {
        const list = (memberships.get(change.GrantMembership.role) ?? []).filter((item) => item.member !== change.GrantMembership.member);
        // The sealed-orders contract holds a role to fill orders: a service, not an AI agent.
        const service = change.GrantMembership.member === this.config.sealedOrdersId ? "sealed orders" : undefined;
        memberships.set(change.GrantMembership.role, [...list, { member: change.GrantMembership.member, kind: change.GrantMembership.kind, ...(service ? { service } : {}) }]);
      }
      if ("RevokeMembership" in change) {
        memberships.set(change.RevokeMembership.role, (memberships.get(change.RevokeMembership.role) ?? []).filter((item) => item.member !== change.RevokeMembership.member));
      }
    }
    const roles = await Promise.all([...roleNames].map(async (name) => {
      const view = await this.view<{ config: { enabled: boolean } } | null>(treasury.vaultAccountId, "get_role", { role: name });
      const setRole = [...executed].reverse().find((change) => "SetRole" in change && change.SetRole.role === name) as Extract<RuleChange, { SetRole: unknown }> | undefined;
      const base = setRole ? describeVaultCall({ method: "queue_rule_change", change: setRole }, context) : null;
      // Solana and NEAR rights live in their own changes; the latest of each applies,
      // unless the role was deleted after it (RemoveRole clears them on the vault).
      let removedAt = -1;
      executed.forEach((change, index) => { if ("RemoveRole" in change && change.RemoveRole.role === name) removedAt = index; });
      const sinceRemoval = executed.slice(removedAt + 1);
      const latest = <K extends "SetSolanaPermissions" | "SetNearPermissions" | "SetBankPermission">(kind: K) =>
        [...sinceRemoval].reverse().find((change) => kind in change && (change as Record<K, { role: string }>)[kind].role === name) as Extract<RuleChange, Record<K, unknown>> | undefined;
      const solanaChange = latest("SetSolanaPermissions");
      const nearChange = latest("SetNearPermissions");
      const bankChange = latest("SetBankPermission");
      const extra = [solanaChange, nearChange, bankChange].filter((change): change is NonNullable<typeof change> => Boolean(change));
      const description = base ? { ...base, details: [...base.details, ...extra.flatMap((change) => describeVaultCall({ method: "queue_rule_change", change }, context).details)] } : null;
      const keys = new Set<string>();
      for (const permission of setRole?.SetRole.config.permissions ?? []) {
        for (const condition of permission.conditions) {
          if (condition.operator === 28 || condition.operator === 30) keys.add(condition.compValue.toLowerCase());
        }
      }
      for (const permission of [...(solanaChange?.SetSolanaPermissions.permissions ?? []), ...(nearChange?.SetNearPermissions.permissions ?? [])]) {
        keys.add(hexOf(permission.allowance).toLowerCase());
      }
      if (bankChange?.SetBankPermission.permission) keys.add(hexOf(bankChange.SetBankPermission.permission.allowance).toLowerCase());
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
   * The call an agent sends to share revenue with the company's shareholders:
   * ETH from the company wallet to the shares contract, through the Omni
   * Bridge. Built here for convenience; the vault only signs it if the agent's
   * role allows exactly this recipient and budget.
   */
  async shareRevenueOperation(organizationId: string, amountWei: string) {
    const treasury = await this.requireTreasury(organizationId);
    const sharesAccountId = this.sharesAccountOf(treasury);
    if (!(await this.accountExists(sharesAccountId))) throw new OmniRolesError(409, "shares_missing", "this company has no shares yet");
    const bridge = PROFILE.omniBridge;
    if (!bridge) throw new OmniRolesError(409, "bridge_missing", `no Omni Bridge known on ${PROFILE.name}`);
    const wallet = await this.view<{ address: number[] | null } | null>(treasury.vaultAccountId, "get_wallet", { chain_id: PROFILE.chainId }).catch(() => null);
    if (!wallet?.address) throw new OmniRolesError(409, "wallet_missing", `the company wallet is not created on ${PROFILE.name} yet`);
    const from = getAddress(hexOf(wallet.address));
    const amount = BigInt(amountWei);
    if (amount <= 0n) throw new OmniRolesError(400, "invalid_amount", "the amount must be above zero");
    const recipient = nearRecipient(sharesAccountId);
    const feeUrl = new URL("/api/v3/transfer-fee", this.config.omniBridgeApi ?? "https://testnet.api.bridge.nearone.org");
    feeUrl.search = new URLSearchParams({ sender: `base:${from}`, recipient, token: "base:0x0000000000000000000000000000000000000000", amount: amount.toString() }).toString();
    let bridgeFee: bigint;
    try {
      const response = await fetch(feeUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bridgeFee = BigInt(((await response.json()) as { native_token_fee?: string | null }).native_token_fee ?? "0");
    } catch (error) {
      throw new OmniRolesError(503, "bridge_fee_unavailable", `the Omni Bridge fee API did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (bridgeFee > MAX_BRIDGE_FEE_WEI) {
      throw new OmniRolesError(422, "bridge_fee_too_high", `the bridge asks ${formatUnits(bridgeFee, 18)} ETH, above the ${formatUnits(MAX_BRIDGE_FEE_WEI, 18)} ETH the role accepts`);
    }
    const call = shareRevenueCall(bridge, sharesAccountId, amount, bridgeFee);
    let fees;
    try {
      fees = await this.chain.fees({ chainId: PROFILE.chainId, from, calls: [{ to: call.to, value: BigInt(call.value), data: call.data }] });
    } catch (error) {
      if (!(error instanceof GasEstimateError)) throw error;
      if (error.code === "would_revert") throw new OmniRolesError(422, "would_revert", `the bridge call would fail: ${error.message}`);
      throw new OmniRolesError(503, "gas_estimate_unavailable", `no ${PROFILE.name} RPC could estimate the bridge call: ${error.message}`);
    }
    return {
      chainId: PROFILE.chainId,
      ...call,
      gasLimit: fees.gasLimits[0]!.toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      recipient,
      bridgeFee: bridgeFee.toString(),
      sharesAccountId,
    };
  }

  /**
   * What happened, as the chains record it. Operations come from the vault on
   * NEAR (who, which role, what, its state) and are confirmed on the EVM chain
   * (mined, success or reverted). The database only says which operations to
   * look up and gives names. Refusals and dry runs never reach a chain: they are
   * listed apart, as Euthyna's own record.
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
    const rowEntries = await inPool(rows, ACTIVITY_READS, (row) => this.ledgerEntry(row.vaultAccountId ?? treasury.vaultAccountId, row.opId).catch(() => null));
    for (const [index, row] of rows.entries()) {
      const vaultAccountId = row.vaultAccountId ?? treasury.vaultAccountId;
      const recorded = rowEntries[index];
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

    // Agents acting directly on the vault (MCP + signer) never reach our database:
    // the vault's own logs, read from the chain, are the record.
    const seen = new Set(operations.map((item) => item.opId.toLowerCase()));
    // If the index does not answer, say so: an empty list would read as "the agents did nothing".
    // What was found before is in the database: an index that does not answer only delays the newest.
    let chainIndex: "complete" | "unavailable" | "off" = this.config.txIndexerUrl ? "complete" : "off";
    const store = this.vaultLogStore();
    const logs = this.config.txIndexerUrl
      ? await this.memo(`vault-logs:${treasury.vaultAccountId}`, 20_000, () => vaultLogs(this.config.txIndexerUrl!, treasury.vaultAccountId, store)).catch(async (error: unknown) => {
        chainIndex = "unavailable";
        console.warn(JSON.stringify({ event: "omniroles.activity_index_unavailable", vaultAccountId: treasury.vaultAccountId, error: String(error).slice(0, 200) }));
        return store.list(treasury.vaultAccountId).catch(() => [] as VaultLog[]);
      })
      : [];
    // A euro payout is one row: its EURC transfer to the partner is part of it, not a second line.
    // A payout's record stops changing once refused, or once its transfer is queued: kept, so the
    // page (refreshed every few seconds) reads only the payouts still waiting for the enclave.
    const payouts = new Map<string, BankPayout>();
    await inPool(logs.filter((log) => log.kind === "bank"), ACTIVITY_READS, async (log) => {
      const key = `${treasury.vaultAccountId}:${log.opId}`;
      const kept = this.settledPayouts.get(key);
      if (kept) return void payouts.set(log.opId, kept);
      const payout = await this.near.viewFunction<BankPayout | null>(treasury.vaultAccountId, "get_bank_payout", { op_id: Array.from(Buffer.from(log.opId.slice(2), "hex")) }).catch(() => null);
      if (!payout) return;
      payouts.set(log.opId, payout);
      if (payout.state === "Failed" || (payout.state === "Transferring" && payout.transfer_op_id)) this.settledPayouts.set(key, payout);
    });
    const transferOf = new Map([...payouts.values()].filter((payout) => payout.transfer_op_id).map((payout) => [hexOf(payout.transfer_op_id!).toLowerCase(), payout]));
    // Every operation's ledger entry, read together (the finished ones come from memory).
    const entries = new Map<string, Awaited<ReturnType<OmniRolesService["ledgerEntry"]>>>();
    const wanted = new Set<string>([
      ...logs.filter((log) => log.kind === "evm" || log.kind === "dao").map((log) => log.opId),
      ...[...payouts.values()].filter((payout) => payout.transfer_op_id).map((payout) => hexOf(payout.transfer_op_id!)),
    ]);
    await inPool([...wanted], ACTIVITY_READS, async (opId) => entries.set(opId.toLowerCase(), await this.ledgerEntry(treasury.vaultAccountId, opId).catch(() => null)));
    const entryOf = (opId: string) => (entries.has(opId.toLowerCase()) ? Promise.resolve(entries.get(opId.toLowerCase()) ?? null) : this.ledgerEntry(treasury.vaultAccountId, opId).catch(() => null));
    // Solana and NEAR operations, read together rather than one after another.
    const opArg = (opId: string) => ({ op_id: Array.from(Buffer.from(opId.slice(2), "hex")) });
    const opViews = new Map<string, unknown>();
    await inPool(logs.filter((log) => log.kind === "solana" || log.kind === "near"), ACTIVITY_READS, async (log) => {
      const method = log.kind === "solana" ? "get_solana_operation" : "get_near_operation";
      opViews.set(log.opId, await this.near.viewFunction<unknown>(treasury.vaultAccountId, method, opArg(log.opId)).catch(() => null));
    });
    for (const log of logs) {
      if (seen.has(log.opId) || transferOf.has(log.opId)) continue;
      if (log.kind === "bank") {
        const payout = payouts.get(log.opId);
        if (!payout) continue;
        const transfer = payout.transfer_op_id ? await entryOf(hexOf(payout.transfer_op_id)) : null;
        const euros = formatUnits(BigInt(payout.amount), 6);
        operations.push({
          opId: log.opId,
          at: log.at,
          actor: agentByAccount.get(payout.member) ?? payout.member,
          role: payout.role,
          reference: payout.reference,
          chainId: treasury.baseChainId,
          chain: "Bank (SEPA)",
          summary: `Pay ${euros} EUR to bank beneficiary #${payout.beneficiary_id}${payout.beneficiary_label ? ` (${payout.beneficiary_label})` : ""} through the bank partner`,
          vaultState: payout.state === "Transferring" ? transfer?.operation.state ?? "Scheduled" : payout.state,
          nonce: transfer?.operation.evm_nonce ?? null,
          evm: transfer?.evmHash ? { hash: transfer.evmHash, status: transfer.receipt?.status ?? "not mined", blockNumber: transfer.receipt?.blockNumber ?? null } : null,
          bank: { state: payout.state, ruleId: payout.rule_id, fiatAmount: payout.fiat_amount, error: payout.error, transferOpId: payout.transfer_op_id ? hexOf(payout.transfer_op_id) : null },
          nearAuthorizationTxHash: log.txHash,
          vaultAccountId: treasury.vaultAccountId,
        });
        continue;
      }
      if (log.kind === "solana") {
        const op = opViews.get(log.opId) as SolanaOperationView | null;
        if (!op) continue;
        const mint = op.request.asset === "Sol" ? null : base58Encode(op.request.asset.Spl.mint);
        const token = SOLANA_DEVNET.tokens.find((item) => item.mint === mint) ?? { symbol: mint ? short(mint) : "SOL", decimals: mint ? 0 : 9 };
        const signature = op.signature ? base58Encode(op.signature) : null;
        operations.push({
          opId: log.opId,
          at: log.at,
          actor: agentByAccount.get(op.member) ?? op.member,
          role: op.role,
          reference: op.request.reference,
          chainId: 0,
          chain: SOLANA_DEVNET.name,
          summary: `Send ${formatUnits(BigInt(op.request.amount), token.decimals)} ${token.symbol} to ${labels[base58Encode(op.request.to)] ?? base58Encode(op.request.to)}`,
          vaultState: op.state,
          nonce: null,
          evm: null,
          solana: signature ? { signature, explorer: SOLANA_DEVNET.explorer.replace("{tx}", signature) } : null,
          nearAuthorizationTxHash: log.txHash,
          vaultAccountId: treasury.vaultAccountId,
        });
        continue;
      }
      if (log.kind === "near") {
        const op = opViews.get(log.opId) as NearOperationView | null;
        if (!op) continue;
        const token = NEAR_TESTNET_TOKENS.find((item) => item.accountId === op.request.token) ?? { symbol: short(op.request.token), decimals: 0 };
        operations.push({
          opId: log.opId,
          at: log.at,
          actor: agentByAccount.get(op.member) ?? op.member,
          role: op.role,
          reference: op.request.reference,
          chainId: 0,
          chain: "NEAR",
          summary: nearTransferSummary(op.request, token, labels[op.request.receiver_id] ?? cardOwner(op.request.receiver_id, agents)),
          vaultState: op.state,
          nonce: null,
          evm: null,
          near: { txHash: log.txHash, explorer: `https://testnet.nearblocks.io/txns/${log.txHash}` },
          nearAuthorizationTxHash: log.txHash,
          vaultAccountId: treasury.vaultAccountId,
        });
        continue;
      }
      const recorded = await entryOf(log.opId);
      if (!recorded) continue;
      const { operation, evmHash, receipt } = recorded;
      operations.push({
        opId: log.opId,
        at: log.at,
        actor: operation.role === "__dao__" ? "Members (DAO vote)" : agentByAccount.get(operation.member) ?? operation.member,
        role: operation.role === "__dao__" ? null : operation.role,
        reference: operation.request.reference,
        chainId: operation.request.chain_id,
        chain: chainName(operation.request.chain_id),
        summary: describeRequest(getAddress(hexOf(operation.request.target)), hexOf(operation.request.calldata), BigInt(operation.request.value)),
        vaultState: operation.state,
        nonce: operation.evm_nonce,
        evm: evmHash ? { hash: evmHash, status: receipt?.status ?? "not mined", blockNumber: receipt?.blockNumber ?? null } : null,
        nearAuthorizationTxHash: log.txHash,
        vaultAccountId: treasury.vaultAccountId,
      });
    }
    operations.sort((a, b) => b.at.localeCompare(a.at));

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
    return { operations, integrity, requests, chainIndex };
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

  /**
   * Drop cached reads of this organization's DAO and vault (after a member's transaction). Reads
   * use "final" blocks, a few seconds behind the transaction: forget again once they caught up, or
   * the console keeps the pre-vote state cached for another round.
   */
  async refresh(organizationId: string): Promise<void> {
    const treasury = await this.treasury(organizationId);
    if (!treasury) return;
    const forget = () => {
      this.forget(treasury.vaultAccountId);
      this.forget(treasury.daoAccountId);
    };
    forget();
    for (const delay of [3_000, 7_000]) setTimeout(forget, delay).unref?.();
    // The vote may have queued a rule: read the vault on the next pass, once the blocks are final.
    this.nextActivationCheck.set(treasury.vaultAccountId, Date.now() + 8_000);
    this.ruleFacts.delete(treasury.vaultAccountId);
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
      // Bridge recipients are compared by hash: name the company's shares contract.
      const shares = this.sharesAccountOf(treasury);
      labels[stringHash(nearRecipient(shares))] = `${nearRecipient(shares)} (company shares)`;
      // A bank payout's EURC goes to the partner's single-use deposit address: name it, so the
      // transfer reads as the payout it is, not as an unknown recipient.
      const count = await this.view<number>(treasury.vaultAccountId, "count_bank_payouts").catch(() => 0);
      if (count) {
        const payouts = await this.view<BankPayout[]>(treasury.vaultAccountId, "list_bank_payouts", { from_index: Math.max(0, count - 50), limit: 50 }).catch(() => []);
        for (const payout of payouts) {
          if (!payout.deposit_address) continue;
          const address = getAddress(hexOf(payout.deposit_address));
          labels[address] ??= `the bank partner (payout to ${payout.beneficiary_label})`;
        }
      }
    }
    return labels;
  }

  private async treasury(organizationId: string) {
    return this.prisma.treasury.findUnique({ where: { organizationId_environment: { organizationId, environment: "uat" } } });
  }

  /** The vault operations found in the chain's logs, kept in the database (see VaultOperationLog). */
  private vaultLogStore(): VaultLogStore {
    const prisma = this.prisma;
    return {
      readTxs: async (vaultAccountId) => new Set((await prisma.vaultTxRead.findMany({ where: { vaultAccountId }, select: { txHash: true } })).map((row) => row.txHash)),
      save: async (vaultAccountId, txHashes, logs) => {
        if (logs.length) {
          await prisma.vaultOperationLog.createMany({
            data: logs.map((log) => ({ vaultAccountId, opId: log.opId, kind: log.kind, txHash: log.txHash, at: new Date(log.at) })),
            skipDuplicates: true,
          });
        }
        // After the operations: a transaction marked read always has its operations kept.
        if (txHashes.length) await prisma.vaultTxRead.createMany({ data: txHashes.map((txHash) => ({ vaultAccountId, txHash })), skipDuplicates: true });
      },
      list: async (vaultAccountId) => (await prisma.vaultOperationLog.findMany({ where: { vaultAccountId }, orderBy: { at: "desc" } }))
        .map((row) => ({ kind: row.kind as VaultLog["kind"], opId: row.opId as `0x${string}`, txHash: row.txHash, at: row.at.toISOString() })),
    };
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

  /**
   * The company's Solana wallet: null on vaults older than the Solana version,
   * { address: null } until the members vote it.
   */
  private async solanaWallet(vaultAccountId: string): Promise<{ supported: boolean; address: string | null; sol: string | null; network: string } | null> {
    const wallet = await this.near.viewFunction<{ address: number[] | null } | null>(vaultAccountId, "get_solana_wallet").then(
      (value) => ({ value }),
      () => null,
    );
    if (!wallet) return { supported: false, address: null, sol: null, network: SOLANA_DEVNET.name };
    const address = wallet.value?.address ? base58Encode(wallet.value.address) : null;
    let sol: string | null = null;
    if (address) {
      const lamports = await solanaRpc(this.config.solanaRpcUrl ?? SOLANA_DEVNET.rpcUrl)<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]).catch(() => null);
      sol = lamports ? (lamports.value / 1e9).toString() : lamports === null ? null : "0";
    }
    return { supported: true, address, sol, network: SOLANA_DEVNET.name };
  }

  /** Versions published on Nomos, oldest first; code hashes are base58 sha256. */
  private async vaultVersions(nomosId = this.config.nomosId): Promise<Array<{ codeHash: string; sha256: string }>> {
    const versions = await this.memo<Array<{ code_hash: string }>>(`nomos-versions:${nomosId}`, 60_000, () =>
      this.near.viewFunction<Array<{ code_hash: string }>>(nomosId, "versions"));
    return versions.map((version) => ({ codeHash: version.code_hash, sha256: Buffer.from(bs58.decode(version.code_hash)).toString("hex") }));
  }

  private async latestVaultVersion(): Promise<{ codeHash: string; sha256: string }> {
    const latest = (await this.vaultVersions()).at(-1);
    if (!latest) throw new OmniRolesError(503, "no_vault_version", `no vault version is published on ${this.config.nomosId}`);
    return latest;
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

