import { api } from "./api.js";

export type Check = { label: string; ok: boolean; expected: string; actual: string };

export type OmniStatus = {
  treasury: null | {
    daoAccountId: string;
    vaultAccountId: string;
    chainId: number;
    chainName: string;
    status: "wallet_pending" | "active" | string;
  };
  checks: Check[];
  dao: null | { members: string[]; threshold: unknown };
  wallet: null | { address: string; eth: string; tokens: Array<{ symbol: string; address: string; amount: string }> };
  chains?: Array<{ chainId: number; name: string; enabled: boolean }>;
  /** null before the treasury; supported=false on vaults older than the Solana version. */
  solana?: null | { supported: boolean; address: string | null; sol: string | null; network: string };
  paused: boolean;
};

export type DaoTransactionView = { opId: string; state: string; createdAt: string; executesAt: string | null; title: string; details: string[] };

export type OmniPlan = {
  daoAccountId: string;
  vaultAccountId: string;
  council: Array<{ memberId: string; nearAccountId: string; name: string | null }>;
  threshold: number;
  ruleDelaySeconds: number;
  vaultWasmSha256: string;
};

export type Sentence = { title: string; details: string[] };

export type DirectoryView = {
  registryId: string | null;
  daoAccountId: string;
  vaultAccountId: string;
  sharesAccountId: string | null;
  listing: null | { name: string; description: string; vault_id: string; shares_id: string | null; registered_at_ns: string };
};

export type ProposalDraft = {
  receiverId: string;
  args: { proposal: { description: string; kind: unknown } };
  deposit: string;
  title: string;
  summary: Sentence[];
};

export type GovernanceProposal = {
  id: number;
  title: string;
  fromConsole: boolean;
  proposer: string;
  status: string;
  votes: Record<string, string>;
  /** Weighted totals per DAO role: [approve, reject, remove]. */
  voteCounts?: Record<string, [string, string, string]>;
  kind: unknown;
  submittedAt: string;
  expiresAt: string;
  changes: Sentence[];
};

export type GovernanceRule = Sentence & {
  queueId: string;
  state: "Queued" | "Executed" | "Vetoed" | "Expired";
  readyToActivate: boolean;
  queuedAt: string;
  activatesAt: string;
  expiresAt: string;
  vetoedBy: string | null;
};

export type Governance = {
  dao: { accountId: string; members: string[]; threshold: unknown; proposalPeriodNs: string; shareholders?: { lockedShares: string } | null };
  vaultAccountId: string;
  paused: boolean;
  proposals: GovernanceProposal[];
  rules: GovernanceRule[];
  transactions?: DaoTransactionView[];
};

export type RoleView = {
  name: string;
  enabled: boolean;
  description: Sentence | null;
  budgets: Array<{ key: string; label: string; token: string | null; available: string | null; max: string | null; periodDays: number | null }>;
  members: Array<{ member: string; kind: string }>;
};

/** An operation as the vault (NEAR) and the EVM chain record it. */
export type OnchainOperation = {
  opId: string;
  at: string;
  actor: string;
  role: string | null;
  reference: string;
  chainId: number;
  chain: string;
  summary: string | null;
  vaultState: string;
  nonce: number | null;
  evm: { hash: string; status: "success" | "reverted" | "not mined"; blockNumber: string | null } | null;
  /** Solana operations: the transaction signature and its explorer page. */
  solana?: { signature: string; explorer: string } | null;
  /** NEP-141 transfer from the vault account: ft_transfer and its result in one NEAR transaction. */
  near?: { txHash: string; explorer: string } | null;
  nearAuthorizationTxHash: string | null;
  vaultAccountId: string;
};

/** Wallet nonce on the chain against the vault's: equal means every transaction came through the vault. */
export type WalletIntegrity = {
  chainId: number;
  chain: string;
  address: string;
  walletNonce: number | null;
  vaultNonce: number;
  status: "ok" | "pending" | "alert" | "unknown";
};

/** Refusals and dry runs: Euthyna's own record, they never reach a chain. */
export type ActivityItem = {
  kind: "refusal" | "allowed";
  at: string;
  agent: string;
  reference: string;
  reason: string | null;
  summary: string | null;
  request?: { chainId: number; to: string; data: string; value: string } | null;
};

export type Activity = { operations: OnchainOperation[]; integrity: WalletIntegrity[]; requests: ActivityItem[] };

export type SharesEpoch = { near: string; token: string; voted_shares: string };

export type SharesInfo = {
  epoch_ns: string;
  current_epoch: number;
  current_epoch_ends_ns: string;
  current: SharesEpoch;
  last: SharesEpoch;
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

export type SharesHolder = {
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

export type SharesView =
  | { accountId: string; deployed: false }
  | {
    accountId: string;
    deployed: true;
    keyless: boolean;
    revenueToken: null | { accountId: string; symbol: string; decimals: number };
    daoAccountId: string;
    vaultAccountId: string;
    info: SharesInfo;
    votesCounted: boolean;
    shareholdersVote: boolean;
    lockedTotal: string;
    me: null | { accountId: string; holder: SharesHolder | null; votes: string; lastEpochVote: number | null };
  };

export type SharesDraft = {
  name: string;
  symbol: string;
  totalSupply: number;
  priceNear: string;
  allocations: Array<{ accountId: string; shares: number }>;
};

export type CouncilMember = { id: string; nearAccountId: string | null; name: string | null; role: string; signedIn: boolean };
type Members = { locked: boolean; members: CouncilMember[]; me?: string | null };

export type BankView = {
  configured: boolean;
  sandbox?: boolean;
  account?: null | { iban: string; bic: string; bankName: string; accountHolder: string; currency: "EUR"; settlesAs: string; network: string; destinationAddress: string; createdAt: string };
  transfers?: Array<{ id: string; created: string; status: string; direction: "in" | "out"; amount: string; currency: string; network: string; txHash: string | null; explorer: string | null }>;
};

export type BankBusiness = {
  registeredName: string; registrationNumber: string; entityType: string; country: string; street: string; city: string;
  postCode: string; state: string; incorporationDate: string; taxId: string; email?: string;
};

export const bankApi = {
  view: () => api<BankView>("/v1/console/bank"),
  open: (input: BankBusiness) => api<BankView>("/v1/console/bank", { method: "POST", body: JSON.stringify(input) }),
  simulate: (amount: string) => api<{ depositId: string }>("/v1/console/bank/simulate", { method: "POST", body: JSON.stringify({ amount }) }),
};

export const omni = {
  members: () => api<Members>("/v1/console/omniroles/members"),
  addMember: (input: { nearAccountId: string; name?: string }) => api<Members>("/v1/console/omniroles/members", { method: "POST", body: JSON.stringify(input) }),
  removeMember: (id: string) => api<Members>(`/v1/console/omniroles/members/${id}`, { method: "DELETE" }),
  status: () => api<OmniStatus>("/v1/console/omniroles/status"),
  plan: (daoName: string) => api<OmniPlan>("/v1/console/omniroles/plan", { method: "POST", body: JSON.stringify({ daoName }) }),
  create: (daoName: string) => api<{ daoTransaction: string; vaultTransaction: string }>("/v1/console/omniroles/create", { method: "POST", body: JSON.stringify({ daoName }) }),
  walletProposal: (chainId?: number) => api<ProposalDraft>("/v1/console/omniroles/proposals/wallet", { method: "POST", body: JSON.stringify(chainId ? { chainId } : {}) }),
  versions: () => api<VaultVersions>("/v1/console/omniroles/versions"),
  holdings: () => api<Holdings>("/v1/console/omniroles/holdings"),
  upgradeProposal: (codeHash: string) => api<ProposalDraft>("/v1/console/omniroles/proposals/upgrade", { method: "POST", body: JSON.stringify({ codeHash }) }),
  solanaWalletProposal: () => api<ProposalDraft>("/v1/console/omniroles/proposals/wallet", { method: "POST", body: JSON.stringify({ solana: true }) }),
  transactionProposal: (input: { title?: string; transactions: Array<{ chainId: number; to: string; value?: string; data?: string; gas?: string }> }) =>
    api<ProposalDraft>("/v1/console/omniroles/proposals/transaction", { method: "POST", body: JSON.stringify(input) }),
  roleProposal: (draft: unknown) => api<ProposalDraft>("/v1/console/omniroles/proposals/role", { method: "POST", body: JSON.stringify({ draft }) }),
  membershipProposal: (input: { role: string; member: string; kind: "Agent" | "Human"; action: "grant" | "revoke" }) =>
    api<ProposalDraft>("/v1/console/omniroles/proposals/membership", { method: "POST", body: JSON.stringify(input) }),
  membersProposals: (members: string[]) => api<{ proposals: ProposalDraft[] }>("/v1/console/omniroles/proposals/members", { method: "POST", body: JSON.stringify({ members }) }),
  fireProposal: (member: string) => api<ProposalDraft>("/v1/console/omniroles/proposals/fire", { method: "POST", body: JSON.stringify({ member }) }),
  budgetProposal: (key: string, amount: string) => api<ProposalDraft>("/v1/console/omniroles/proposals/budget", { method: "POST", body: JSON.stringify({ key, amount }) }),
  pauseProposal: (pause: boolean) => api<ProposalDraft>("/v1/console/omniroles/proposals/pause", { method: "POST", body: JSON.stringify({ pause }) }),
  governance: () => api<Governance>("/v1/console/omniroles/governance"),
  activate: () => api<{ transactions: string[] }>("/v1/console/omniroles/rules/activate", { method: "POST", body: "{}" }),
  roles: () => api<{ roles: RoleView[] }>("/v1/console/omniroles/roles"),
  activity: () => api<Activity>("/v1/console/omniroles/activity"),
  shares: () => api<SharesView>("/v1/console/omniroles/shares"),
  createShares: (draft: SharesDraft) =>
    api<{ accountId: string; transaction: string; proposals: ProposalDraft[] }>("/v1/console/omniroles/shares", { method: "POST", body: JSON.stringify(draft) }),
  sharesProposals: () => api<{ proposals: ProposalDraft[] }>("/v1/console/omniroles/proposals/shares", { method: "POST", body: "{}" }),
  proceedsProposals: (input: { chainId: number; amountNear: string }) =>
    api<{ companyWallet: string; messageAccount: string; proposals: ProposalDraft[] }>("/v1/console/omniroles/proposals/proceeds", { method: "POST", body: JSON.stringify(input) }),
  directory: () => api<DirectoryView>("/v1/console/omniroles/directory"),
  registryProposal: (input: { name: string; description: string }) =>
    api<ProposalDraft>("/v1/console/omniroles/proposals/registry", { method: "POST", body: JSON.stringify(input) }),
  revenueProposal: (amountNear: string) => api<ProposalDraft>("/v1/console/omniroles/proposals/revenue", { method: "POST", body: JSON.stringify({ amountNear }) }),
  sealed: () => api<SealedView>("/v1/console/omniroles/sealed"),
  sealedOrder: (input: { role: string; commitment: string; slippageBps: number; terms: string | null; approveUsdc: string | null }) =>
    api<ProposalDraft>("/v1/console/omniroles/proposals/sealed-order", { method: "POST", body: JSON.stringify(input) }),
  sealedCancel: (id: number) => api<ProposalDraft>("/v1/console/omniroles/proposals/sealed-cancel", { method: "POST", body: JSON.stringify({ id }) }),
};

export type SealedOrderView = {
  id: number; vault: string; role: string; chain_id: number; wallet: string; sealer: string; commitment: string;
  slippage_bps: number; filled: string; fills: number; cancelled: boolean; sealed_at_ns: string; terms: string | null;
};
export type SealedView = {
  enabled: boolean;
  sealedAccountId: string | null;
  vaultAccountId: string;
  daoAccountId: string;
  router: string;
  tokenIn: string;
  tokenOut: string;
  chainId: number;
  roles: Array<{ name: string; agents: string[]; budgets: Array<{ label: string; token: string | null; available: string | null; max: string | null; periodDays: number | null }> }>;
  orders: SealedOrderView[];
  readers: Array<{ account: string; public_key: string }>;
  /** USDC the router may take from the wallet now (raw units), null when unknown. */
  allowance: string | null;
};

export function thresholdText(threshold: unknown, members: number): string {
  if (Array.isArray(threshold) && threshold.length === 2) return `${Math.max(1, Math.ceil((members * Number(threshold[0])) / Number(threshold[1])))} of ${members}`;
  if (typeof threshold === "string" || typeof threshold === "number") return `${threshold} of ${members}`;
  return `majority of ${members}`;
}

export function approvalsNeeded(threshold: unknown, members: number): number {
  if (Array.isArray(threshold) && threshold.length === 2) return Math.max(1, Math.ceil((members * Number(threshold[0])) / Number(threshold[1])));
  const value = Number(threshold);
  return Number.isFinite(value) && value > 0 ? value : Math.floor(members / 2) + 1;
}

export type VaultVersions = {
  vaultAccountId: string;
  nomosId: string;
  current: string;
  latest: string | null;
  upgradable: boolean;
  versions: Array<{ index: number; codeHash: string; size: number; notes: string; publishedAt: string; current: boolean }>;
};

export type Holdings = {
  chains: Array<{ chain: string; address: string; explorer: string; usd: number; assets: Array<{ symbol: string; amount: string; where: string; usd: number | null }> }>;
  /** Sum of the assets that have a reference price. */
  totalUsd: number;
  indicative: boolean;
};

/** "0.0006 WETH" with at most 6 significant digits. */
export function formatAmount(amount: string, symbol: string): string {
  const value = Number(amount);
  return `${value >= 1 ? value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : Number(value.toPrecision(4)).toString()} ${symbol}`;
}
