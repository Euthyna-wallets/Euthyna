/**
 * Editing a role: the browser reads the role from the vault itself (not from the server), rebuilds
 * the draft that compiles to it, and edits that. Budgets left as they are are not re-sent, so an edit
 * never refills what was already spent this period.
 */
import { BASE_SEPOLIA, Operator, roleDraftFromChain, type ChainRole, type NearPermission, type RoleConfig, type RoleDraft, type SolanaPermission } from "@euthyna/sdk/roles";

import { viewContract } from "../wallets.js";

export type EditableRole = {
  draft: RoleDraft;
  /** Members as the vault holds them (kind kept), the sealed-orders contract included. */
  members: Array<{ member: string; kind: string; service?: string }>;
  hadSolana: boolean;
  /** The sealed-orders contract of this server, when sealed orders are on. */
  sealedId: string | null;
};

const hex = (bytes: number[]) => `0x${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

export async function loadEditableRole(input: {
  vaultAccountId: string;
  name: string;
  members: Array<{ member: string; kind: string; service?: string }>;
  sharesAccountId: string | null;
  sealedId: string | null;
}): Promise<EditableRole | null> {
  const { vaultAccountId, name } = input;
  const view = await viewContract<{ config: RoleConfig } | null>(vaultAccountId, "get_role", { role: name });
  if (!view) return null;
  // Older vaults have no NEAR or Solana rights: no such view, no such rights.
  const near = await viewContract<NearPermission[]>(vaultAccountId, "get_near_permissions", { role: name }).catch(() => []);
  const solana = await viewContract<SolanaPermission[]>(vaultAccountId, "get_solana_permissions", { role: name }).catch(() => []);
  const keys = new Set<string>();
  for (const permission of view.config.permissions) {
    for (const condition of permission.conditions) if (condition.operator === Operator.WithinAllowance) keys.add(condition.compValue.toLowerCase());
  }
  for (const permission of [...near, ...solana]) keys.add(hex(permission.allowance));
  const allowances: ChainRole["allowances"] = {};
  for (const key of keys) {
    const allowance = await viewContract<{ refill: string; period_ns: number } | null>(vaultAccountId, "get_allowance", { key: Array.from(key.slice(2).match(/../g)!, (pair) => parseInt(pair, 16)) });
    if (allowance) allowances[key] = { refill: allowance.refill, period_ns: Number(allowance.period_ns) };
  }
  const draft = roleDraftFromChain({ name, config: view.config, allowances, near, solana, sharesAccountId: input.sharesAccountId }, BASE_SEPOLIA);
  return draft ? { draft, members: input.members, hadSolana: solana.length > 0, sealedId: input.sealedId } : null;
}
