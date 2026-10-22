export const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export type TreasuryView = {
  organizationId: string;
  environment: string;
  daoAccountId: string;
  vaultAccountId: string;
  relayAccountId: string;
  safeAddress: string;
  rolesAddress: string;
  delayAddress: string;
  govAddress: string;
  status: string;
};

export type NearAction =
  | { type: "CreateAccount"; description: string }
  | { type: "Transfer"; depositYocto: string; description: string }
  | { type: "DeployContract"; codeBase64: string; description: string }
  | { type: "FunctionCall"; methodName: string; args: Record<string, unknown>; gasTgas: number; description: string };

export type TreasuryPlan = {
  environment: string;
  daoAccountId: string;
  daoName: string;
  founderNearAccountId: string;
  threshold: number;
  govAddress: string;
  council: Array<{ memberId: string; nearAccountId: string; evmAddress: string }>;
  daoCreate: { factoryId: string; method: string; args: { name: string; args: string }; depositYocto: string };
  vault: {
    accountId: string;
    initArgs: {
      owner_id: string;
      token_id: string;
      mpc_contract_id: string;
      evm_chain_id: number;
      guard_public_key: string;
      reservation_ttl_blocks: number;
    };
    wasmSha256: string;
    actions: NearAction[];
  };
  relay: {
    accountId: string;
    initArgs: {
      owner_id: string;
      mpc_contract_id: string;
      mpc_path: string;
      evm_chain_id: number;
      delay_address: string;
    };
    wasmSha256: string;
    actions: NearAction[];
  };
  base: {
    safeAddress: string;
    rolesAddress: string;
    delayAddress: string;
    safeDeployment: { to: string; value: string; data: string };
    rolesDeployment: { to: string; value: string; data: string };
    delayDeployment: { to: string; value: string; data: string };
    safeModuleCalls: Array<{ to: string; value: string; data: string; description: string }>;
  };
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(body.message ?? body.error ?? response.statusText));
  }
  return body as T;
}

export function explorerNear(accountId: string): string {
  return `https://testnet.nearblocks.io/address/${accountId}`;
}

export function explorerBase(address: string): string {
  return `https://sepolia.basescan.org/address/${address}`;
}


export type BudgetTokenStatus = {
  environment: string;
  tokenAccountId: string;
  symbol: string;
  decimals: number;
  daoAccountId: string;
  vaultAccountId: string;
  daoStorageRegistered: boolean;
  vaultStorageRegistered: boolean;
  daoBalance: string;
  storageDepositYocto: string;
};

export type BudgetTokenPlan = {
  status: BudgetTokenStatus;
  actions: Array<{
    receiverId: string;
    methodName: "storage_deposit" | "mint";
    args: Record<string, unknown>;
    gas: string;
    deposit: string;
    description: string;
  }>;
};

export type MandateProposal = {
  receiverId: string;
  methodName: string;
  description: string;
  args: Record<string, unknown>;
  deposit: string;
};

export type MandatePreview = {
  roleKey: string;
  allowanceKey: string;
  vault: { config: Record<string, unknown>; current: unknown };
  zodiac: { target: string; selector: string; conditions: unknown[]; calls: Array<{ description: string }> };
  guard: Record<string, unknown>;
  diff: Array<{ field: string; current: unknown; next: unknown }>;
  agentStatus: "ready" | "needs_agent_address" | "no_agent";
  proposals: {
    vaultSetRole: MandateProposal;
    vaultRegisterAgent: MandateProposal | null;
    funding: MandateProposal | null;
    zodiacRelay: MandateProposal[];
  };
  warnings: string[];
};

export type OperationRow = {
  opId: string;
  reference: string;
  amount: string;
  state: string;
  status?: string;
  txHash: string | null;
  createdAt: string;
  agentId: string;
};

export type AgentRow = {
  id: string;
  name: string;
  role: string;
  nearAccountId: string;
  nearPublicKey: string;
  vaultAccountId: string;
  evmAddress: string | null;
  mpcPath: string;
  active: boolean;
  createdAt: string;
};
