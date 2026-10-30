import { NEAR_TESTNET_TOKENS } from "@mandateos/sdk/roles";

import type { Activity, ActivityItem, OnchainOperation } from "../omniroles-api.js";
import { tokenAmount, type Sale } from "./market.js";

/** $1,234.56; under a cent shows "< $0.01". */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.01) return "< $0.01";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value >= 1000 ? 0 : 2 });
}

/** 1,234.5 · 0.4 · 0.0006: readable, never more than 4 significant digits below 1. */
export function formatToken(amount: string | number): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return String(amount);
  if (value === 0) return "0";
  if (Math.abs(value) >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return Number(value.toPrecision(2)).toString();
}

/** Display name of a token symbol ("USDC (Aave test)" → "USDC"). */
export function tokenName(symbol: string): string {
  return symbol.replace(/\s*\(.*\)$/, "");
}

/** Numbers inside a sentence: "0.399936 USDC" → "0.4 USDC". */
function roundNumbers(text: string): string {
  return text.replace(/\b\d+\.\d{3,}\b/g, (match) => formatToken(match));
}

/** A plain-English sentence from the vault's description of a call. */
export function sentence(summary: string | null, fallback: string): string {
  if (!summary) return fallback;
  let text = summary
    .replace(/, sent to company wallet$/, "")
    .replace(/ for company wallet$/, "")
    .replace(/ router\b/g, "")
    .replace(/ pool\b/g, "")
    .replace(/^approve (.+) to spend (.+)$/, "Allowed $1 to use $2")
    .replace(/^swap (\S+ \S+) for (\S+) on (.+)$/, "Swapped $1 for $2 on $3")
    .replace(/^deposit (.+) into (.+)$/, "Deposited $1 on $2")
    .replace(/^withdraw (.+) from (.+)$/, "Withdrew $1 from $2")
    .replace(/^transfer (.+) to (.+)$/, "Sent $1 to $2")
    .replace(/^Send (.+) to (.+)$/, "Sent $1 to $2");
  text = roundNumbers(text).replace(/USDC \(Aave test\)/g, "USDC");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type Outcome = "done" | "pending" | "failed" | "refused" | "cancelled";

export const OUTCOME_LABEL: Record<Outcome, string> = {
  done: "Done",
  pending: "In progress",
  failed: "Failed",
  refused: "Refused",
  cancelled: "Cancelled",
};

export function outcomeOf(operation: OnchainOperation): Outcome {
  if (operation.evm?.status === "success") return "done";
  if (operation.evm?.status === "reverted") return "failed";
  if ((operation.solana || operation.near) && operation.vaultState === "Confirmed") return "done";
  if (["Cancelled", "Vetoed", "Expired"].includes(operation.vaultState)) return "cancelled";
  if (operation.vaultState === "Failed") return "failed";
  return "pending";
}

export type Entry = {
  id: string;
  at: string;
  actor: string;
  role: string | null;
  text: string;
  outcome: Outcome;
  chain: string | null;
  reason: string | null;
  operation: OnchainOperation | null;
  /** A refused request, as the agent asked it: members can still vote on it. */
  request: ActivityItem["request"] | null;
  /** A sale by one of the company's listings, or a purchase by one of its agents. */
  market?: { kind: "sale" | "purchase"; sale: Sale };
};

/** Where the money of a market task is: paid, on its way, or never coming. */
function marketOutcome(sale: Sale): Outcome {
  if (sale.holdState === "settled" || sale.holdState === "prepaid") return "done";
  if (sale.state === "expired" || sale.holdState === "expired") return "cancelled";
  if (sale.state === "failed" || sale.state === "completed_unpaid" || sale.holdState === "failed") return "failed";
  return "pending";
}

/** Market sales and purchases as Activity entries. Orders still waiting for a payment moved no money: left out. */
export function marketEntriesOf(sales: Sale[] = [], purchases: Sale[] = []): Entry[] {
  const symbol = (asset: string) => NEAR_TESTNET_TOKENS.find((token) => token.accountId === asset)?.symbol ?? "tokens";
  const price = (sale: Sale) => (sale.amount ? ` for ${tokenAmount(sale.amount)} ${symbol(sale.asset)}` : "");
  const entry = (kind: "sale" | "purchase", sale: Sale): Entry => ({
    id: `market-${kind}-${sale.taskId}`,
    at: sale.completedAt ?? sale.createdAt,
    actor: kind === "sale" ? sale.handle : sale.buyer,
    role: null,
    text: kind === "sale" ? `Sold "${sale.title}"${price(sale)} to ${sale.buyer}` : `Bought "${sale.title}"${price(sale)} from @${sale.handle}`,
    outcome: marketOutcome(sale),
    chain: "NEAR",
    reason: null,
    operation: null,
    request: null,
    market: { kind, sale },
  });
  const paid = (sale: Sale) => sale.state !== "awaiting_payment";
  return [...sales.filter(paid).map((sale) => entry("sale", sale)), ...purchases.filter(paid).map((sale) => entry("purchase", sale))];
}

/** Operations and refusals as one list of plain sentences, newest first. */
export function entriesOf(activity: Activity | undefined): Entry[] {
  if (!activity) return [];
  const operations: Entry[] = activity.operations.map((operation) => ({
    id: operation.opId,
    at: operation.at,
    actor: operation.actor,
    role: operation.role,
    text: sentence(operation.summary, operation.role ? "Operation" : "Transaction voted by the members"),
    outcome: outcomeOf(operation),
    chain: operation.chain,
    reason: null,
    operation,
    request: null,
  }));
  const refusals: Entry[] = activity.requests.filter((request) => request.kind === "refusal").map((request, index) => ({
    id: `refusal-${index}-${request.at}`,
    at: request.at,
    actor: request.agent,
    role: null,
    text: sentence(request.summary, request.reference),
    outcome: "refused",
    chain: null,
    reason: request.reason,
    operation: null,
    request: request.request ?? null,
  }));
  return [...operations, ...refusals].sort((a, b) => b.at.localeCompare(a.at));
}

/** "Investment manager" from "investment-manager". */
export function roleName(role: string): string {
  const text = role.replace(/[-_]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Today", "Yesterday", "Mon 26 Oct". */
export function dayLabel(at: string): string {
  const day = new Date(at);
  const today = new Date();
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return day.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function timeOf(at: string): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
