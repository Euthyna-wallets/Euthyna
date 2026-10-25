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
  dao: { accountId: string; members: string[]; threshold: unknown; proposalPeriodNs: string };
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
  nonce: number;
  evm: { hash: string; status: "success" | "reverted" | "not mined"; blockNumber: string | null } | null;
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

/** Refusals and dry runs: MandateOS's own record, they never reach a chain. */
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

export type CouncilMember = { id: string; nearAccountId: string | null; name: string | null; role: string; signedIn: boolean };
type Members = { locked: boolean; members: CouncilMember[]; me?: string | null };

export const omni = {
  members: () => api<Members>("/v1/console/omniroles/members"),
  addMember: (input: { nearAccountId: string; name?: string }) => api<Members>("/v1/console/omniroles/members", { method: "POST", body: JSON.stringify(input) }),
  removeMember: (id: string) => api<Members>(`/v1/console/omniroles/members/${id}`, { method: "DELETE" }),
  status: () => api<OmniStatus>("/v1/console/omniroles/status"),
  plan: (daoName: string) => api<OmniPlan>("/v1/console/omniroles/plan", { method: "POST", body: JSON.stringify({ daoName }) }),
  create: (daoName: string) => api<{ daoTransaction: string; vaultTransaction: string }>("/v1/console/omniroles/create", { method: "POST", body: JSON.stringify({ daoName }) }),
  walletProposal: (chainId?: number) => api<ProposalDraft>("/v1/console/omniroles/proposals/wallet", { method: "POST", body: JSON.stringify(chainId ? { chainId } : {}) }),
  transactionProposal: (input: { title?: string; transactions: Array<{ chainId: number; to: string; value?: string; data?: string; gas?: string }> }) =>
    api<ProposalDraft>("/v1/console/omniroles/proposals/transaction", { method: "POST", body: JSON.stringify(input) }),
  roleProposal: (draft: unknown) => api<ProposalDraft>("/v1/console/omniroles/proposals/role", { method: "POST", body: JSON.stringify({ draft }) }),
  membershipProposal: (input: { role: string; member: string; kind: "Agent" | "Human"; action: "grant" | "revoke" }) =>
    api<ProposalDraft>("/v1/console/omniroles/proposals/membership", { method: "POST", body: JSON.stringify(input) }),
  membersProposals: (members: string[]) => api<{ proposals: ProposalDraft[] }>("/v1/console/omniroles/proposals/members", { method: "POST", body: JSON.stringify({ members }) }),
  pauseProposal: (pause: boolean) => api<ProposalDraft>("/v1/console/omniroles/proposals/pause", { method: "POST", body: JSON.stringify({ pause }) }),
  governance: () => api<Governance>("/v1/console/omniroles/governance"),
  activate: () => api<{ transactions: string[] }>("/v1/console/omniroles/rules/activate", { method: "POST", body: "{}" }),
  roles: () => api<{ roles: RoleView[] }>("/v1/console/omniroles/roles"),
  activity: () => api<Activity>("/v1/console/omniroles/activity"),
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
