import type { Sentence } from "../omniroles-api.js";

/** One role, as members think of it: what it allows, its budgets, who holds it. */
export type RoleSummary = {
  role: string;
  allows: string[];
  budgets: string[];
  holders: string[];
  removedHolders: string[];
  deleted: boolean;
  disabled: boolean;
};

const ROLE = /role "([^"]+)"/;

/**
 * The vault applies a role as several rule changes (budget, role, membership).
 * Fold them back into one role per name. Budgets carry no role name: they go
 * to the role when the changes concern exactly one.
 */
export function summarizeRoleChanges(changes: Sentence[]): { roles: RoleSummary[]; other: Sentence[] } {
  const roles = new Map<string, RoleSummary>();
  const pendingBudgets: string[] = [];
  const other: Sentence[] = [];
  const of = (name: string) => {
    let summary = roles.get(name);
    if (!summary) {
      summary = { role: name, allows: [], budgets: [], holders: [], removedHolders: [], deleted: false, disabled: false };
      roles.set(name, summary);
    }
    return summary;
  };
  for (const change of changes) {
    const name = change.title.match(ROLE)?.[1];
    if (/^Set role "/.test(change.title) && name) {
      of(name).allows.push(...change.details);
    } else if (/^Disable role "/.test(change.title) && name) {
      of(name).disabled = true;
    } else if (/^Delete role "/.test(change.title) && name) {
      of(name).deleted = true;
    } else if (/^Give role "/.test(change.title) && name) {
      of(name).holders.push(change.title.replace(/^Give role "[^"]+" to /, ""));
    } else if (/^Remove .* from role "/.test(change.title) && name) {
      of(name).removedHolders.push(change.title.replace(/^Remove (.*) from role "[^"]+"$/, "$1"));
    } else if (/ budget: /.test(change.title)) {
      pendingBudgets.push(change.title.replace(/^.* budget: /, ""));
    } else {
      other.push(change);
    }
  }
  const list = [...roles.values()];
  if (list.length === 1) list[0]!.budgets.push(...pendingBudgets);
  else other.push(...pendingBudgets.map((title) => ({ title: `Budget: ${title}`, details: [] })));
  return { roles: list, other };
}

/** "Role "payments"" when every change is about that one role, otherwise null. */
export function singleRoleTitle(changes: Sentence[]): string | null {
  const { roles, other } = summarizeRoleChanges(changes);
  return roles.length === 1 && other.length === 0 ? `Role "${roles[0]!.role}"` : null;
}
