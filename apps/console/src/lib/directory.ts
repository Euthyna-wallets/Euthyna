/**
 * Public directory: everything here is read from NEAR by the browser. The
 * MandateOS API is not involved, so what a visitor sees is what the chain says.
 */
import { BASE_SEPOLIA, budgetsOf, describeVaultCall, formatNear, type RuleChange } from "@mandateos/sdk/roles";
import { formatUnits, getAddress, hexToBytes, toHex, type Hex } from "viem";

import { chainView } from "./chain-view.js";

export const REGISTRY_ID = import.meta.env.VITE_MANDATEOS_REGISTRY_ID ?? "registry.mandateos.testnet";
const PROFILE = BASE_SEPOLIA;

export type DirectoryEntry = {
  dao_id: string;
  vault_id: string;
  shares_id: string | null;
  name: string;
  description: string;
  registered_at_ns: string;
};

export type Employee = {
  role: string;
  enabled: boolean;
  title: string;
  details: string[];
  members: string[];
  budgets: Array<{ label: string; available: string | null; max: string | null; token: string | null; periodDays: number | null }>;
};

export type CompanyProfile = DirectoryEntry & {
  council: string[];
  daoBalanceNear: string;
  vaultKeys: number;
  paused: boolean;
  wallets: Array<{ chainId: number; name: string; address: string }>;
  employees: Employee[];
  shares: null | { symbol: string; total: string; sold: string; priceNear: string; distributedNear: string; epochHours: number };
};

async function rpc<T>(params: Record<string, unknown>): Promise<T> {
  const response = await fetch(import.meta.env.VITE_NEAR_RPC_URL ?? "https://rpc.testnet.near.org", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "mandateos-directory", method: "query", params: { finality: "final", ...params } }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (!payload.result) throw new Error(payload.error?.message ?? "NEAR RPC failed");
  return payload.result;
}

export async function listCompanies(): Promise<DirectoryEntry[]> {
  const all: DirectoryEntry[] = [];
  for (let from = 0; ; from += 100) {
    const page = await chainView<DirectoryEntry[]>(REGISTRY_ID, "list_companies", { from_index: from, limit: 100 });
    all.push(...page);
    if (page.length < 100) return all;
  }
}

type QueuedRule = { change: RuleChange; state: string };

async function employeesOf(vaultId: string): Promise<Employee[]> {
  const rules = await chainView<QueuedRule[]>(vaultId, "list_rule_changes", { before: null, limit: 50 }).catch(() => [] as QueuedRule[]);
  const executed = rules.filter((rule) => rule.state === "Executed").reverse().map((rule) => rule.change);
  const budgets = budgetsOf(executed, PROFILE);
  const context = { profile: PROFILE, budgets };
  const names = new Set<string>();
  const members = new Map<string, Set<string>>();
  for (const change of executed) {
    if ("SetRole" in change) names.add(change.SetRole.role);
    if ("RemoveRole" in change) names.delete(change.RemoveRole.role);
    if ("GrantMembership" in change) members.set(change.GrantMembership.role, (members.get(change.GrantMembership.role) ?? new Set()).add(change.GrantMembership.member));
    if ("RevokeMembership" in change) members.get(change.RevokeMembership.role)?.delete(change.RevokeMembership.member);
  }
  return Promise.all([...names].map(async (role) => {
    const view = await chainView<{ config: { enabled: boolean } } | null>(vaultId, "get_role", { role }).catch(() => null);
    const setRole = [...executed].reverse().find((change) => "SetRole" in change && change.SetRole.role === role) as Extract<RuleChange, { SetRole: unknown }> | undefined;
    const described = setRole ? describeVaultCall({ method: "queue_rule_change", change: setRole }, context) : { title: role, details: [] };
    const keys = new Set<string>();
    for (const permission of setRole?.SetRole.config.permissions ?? []) {
      for (const condition of permission.conditions) {
        if (condition.operator === 28 || condition.operator === 30) keys.add(condition.compValue.toLowerCase());
      }
    }
    const roleBudgets = await Promise.all([...keys].map(async (key) => {
      const bytes = Array.from(hexToBytes(key as Hex));
      const allowance = await chainView<{ balance: string; reserved: string; max_refill: string; period_ns: number } | null>(vaultId, "get_allowance", { key: bytes }).catch(() => null);
      const info = budgets[key];
      const decimals = info?.token?.decimals ?? 18;
      return {
        label: info?.label ?? "budget",
        token: info?.token?.symbol ?? (decimals === 18 ? "ETH" : null),
        available: allowance ? round(formatUnits(BigInt(allowance.balance) - BigInt(allowance.reserved), decimals)) : null,
        max: allowance ? round(formatUnits(BigInt(allowance.max_refill), decimals)) : null,
        periodDays: allowance ? allowance.period_ns / 86_400_000_000_000 : null,
      };
    }));
    const title = /^Set role/.test(described.title) ? "Job contract, voted by the owners" : described.title;
    const details = described.details.map((line) => line.replace(/^[·\s]+/, ""));
    return { role, enabled: view?.config.enabled ?? false, title, details, members: [...(members.get(role) ?? [])], budgets: roleBudgets };
  }));
}

/** Up to 6 decimals, without trailing zeros. */
function round(value: string): string {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

const CHAINS: Array<{ chainId: number; name: string }> = [{ chainId: 84532, name: "Base Sepolia" }, { chainId: 11155111, name: "Ethereum Sepolia" }];

export async function companyProfile(entry: DirectoryEntry): Promise<CompanyProfile> {
  const [policy, account, keys, paused, employees, wallets, shares] = await Promise.all([
    chainView<{ roles: Array<{ kind: unknown }> }>(entry.dao_id, "get_policy"),
    rpc<{ amount: string }>({ request_type: "view_account", account_id: entry.dao_id }),
    rpc<{ keys: unknown[] }>({ request_type: "view_access_key_list", account_id: entry.vault_id }),
    chainView<boolean>(entry.vault_id, "is_paused").catch(() => false),
    employeesOf(entry.vault_id),
    Promise.all(CHAINS.map(async (chain) => {
      const wallet = await chainView<{ address: number[] | null } | null>(entry.vault_id, "get_wallet", { chain_id: chain.chainId }).catch(() => null);
      return wallet?.address ? { ...chain, address: getAddress(toHex(new Uint8Array(wallet.address))) } : null;
    })),
    entry.shares_id
      ? chainView<{ dao_id: string; symbol: string; total_supply: string; unsold: string; price_per_share: string; near_distributed: string; epoch_ns: string }>(entry.shares_id, "info").catch(() => null)
      : Promise.resolve(null),
  ]);
  const council = policy.roles.flatMap((role) => ((role.kind as { Group?: string[] })?.Group ?? []));
  return {
    ...entry,
    council,
    daoBalanceNear: formatNear(account.amount),
    vaultKeys: keys.keys.length,
    paused,
    wallets: wallets.filter((wallet): wallet is NonNullable<typeof wallet> => wallet !== null),
    employees,
    shares: shares && shares.dao_id === entry.dao_id
      ? {
        symbol: shares.symbol,
        total: shares.total_supply,
        sold: (BigInt(shares.total_supply) - BigInt(shares.unsold)).toString(),
        priceNear: formatNear(shares.price_per_share),
        distributedNear: formatNear(shares.near_distributed),
        epochHours: Number(BigInt(shares.epoch_ns) / 3_600_000_000_000n),
      }
      : null,
  };
}
