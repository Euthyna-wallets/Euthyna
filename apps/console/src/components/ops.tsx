import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import type { Activity, RoleView } from "../omniroles-api.js";
import { everyDays, short } from "./ui.js";

/** Line icons for the console (24px grid, stroke = currentColor). */
const PATHS: Record<string, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  agents: <><rect x="5" y="7" width="14" height="11" rx="3" /><path d="M12 3v4M9.5 12h.01M14.5 12h.01M9 21h6" /></>,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  roles: <><rect x="4" y="3" width="16" height="18" rx="2" /><circle cx="12" cy="10" r="3" /><path d="M8 17h8" /></>,
  decisions: <><path d="M9 11l3 3 8-8" /><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" /></>,
  wallet: <><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M16 13h2M3 10h18M7 6l8-3 1 3" /></>,
  shares: <><circle cx="12" cy="12" r="9" /><path d="M12 3v9l6.5 6" /></>,
  suppliers: <><path d="M3 21V9l9-6 9 6v12" /><path d="M9 21v-6h6v6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  check: <path d="M5 12l5 5L20 7" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
  pause: <><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  setup: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></>,
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name] ?? null}
    </svg>
  );
}

const AVATAR_COLORS = ["#4FD1E8", "#F2B544", "#9AA8FF", "#7ED3A2", "#F28C8C", "#C9A2F5"];

/** A stable colored badge for an agent, from its account. */
export function Avatar({ name, seed, size = 40 }: { name: string; seed: string; size?: number }) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  const initials = name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "?";
  return (
    <span className="avatar" style={{ width: size, height: size, background: `${color}22`, color, borderColor: `${color}66`, fontSize: size * 0.38 }}>
      {initials}
    </span>
  );
}

export type AgentState = "working" | "idle" | "paused" | "no role" | "fired";

export function StateDot({ state }: { state: AgentState }) {
  return <span className={`state-dot state-${state.replace(" ", "-")}`}>{state}</span>;
}

/** What is left of a budget, as a gauge. */
export function BudgetGauge({ role, budget }: { role?: string; budget: RoleView["budgets"][number] }) {
  const available = Number(budget.available ?? 0);
  const max = Number(budget.max ?? 0);
  const left = max > 0 ? Math.max(0, Math.min(100, Math.round((available / max) * 100))) : 0;
  return (
    <div className="gauge">
      <div className="gauge-head">
        <span className="gauge-name">{role && role !== budget.label ? <><span className="mono">{role}</span> · </> : null}<span className={role === budget.label ? "mono" : ""}>{budget.label}</span></span>
        <span className="gauge-value"><strong>{available.toLocaleString()}</strong> / {max.toLocaleString()} {budget.token ?? ""}</span>
      </div>
      <div className={`bar${left === 0 ? " empty" : left < 25 ? " low" : ""}`} role="img" aria-label={`${left}% of the budget left`}><span style={{ width: `${left}%` }} /></div>
      <span className="gauge-foot">{left === 0 ? "Spent for this period · " : ""}refills {everyDays(budget.periodDays)}</span>
    </div>
  );
}

export type FeedItem = { at: string; ok: boolean; actor: string; title: string; detail: string; href?: string };

/** Executed operations and refusals, newest first. */
export function feedOf(activity: Activity | undefined): FeedItem[] {
  if (!activity) return [];
  const done: FeedItem[] = activity.operations.map((operation) => {
    // EVM: mined successfully. Solana: finality attested by MPC (vault state Confirmed).
    const ok = operation.evm?.status === "success" || (Boolean(operation.solana) && operation.vaultState === "Confirmed");
    return {
      at: operation.at,
      ok,
      actor: operation.actor,
      title: operation.summary ?? `Operation ${operation.opId}`,
      detail: ok
        ? `${operation.chain} · ${operation.role ? `role ${operation.role}` : "voted transaction"}`
        : `${operation.chain} · ${operation.vaultState}${operation.evm ? ` · ${operation.evm.status}` : ""}`,
    };
  });
  const refused: FeedItem[] = activity.requests.filter((request) => request.kind === "refusal").map((request) => ({
    at: request.at,
    ok: false,
    actor: request.agent,
    title: request.summary ?? request.reference,
    detail: `Refused · ${request.reason ?? "outside the role"}`,
  }));
  return [...done, ...refused].sort((a, b) => b.at.localeCompare(a.at));
}

export function ago(at: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

/** "in 50 min", "in 3 h", "now". */
export function until(at: string): string {
  const seconds = (new Date(at).getTime() - Date.now()) / 1000;
  if (seconds <= 60) return "now";
  if (seconds < 3600) return `in ${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `in ${Math.round(seconds / 3600)} h`;
  return `in ${Math.round(seconds / 86_400)} d`;
}

export function Feed({ items, limit, nameOf }: { items: FeedItem[]; limit?: number; nameOf?: (actor: string) => string }) {
  const shown = limit ? items.slice(0, limit) : items;
  if (shown.length === 0) return <div className="state">Nothing yet. Operations and refusals show up here as they happen.</div>;
  return (
    <ol className="feed">
      {shown.map((item, index) => (
        <li key={`${item.at}-${index}`} className={item.ok ? "ok" : "refused"}>
          <span className="feed-icon"><Icon name={item.ok ? "check" : "cross"} size={14} /></span>
          <div className="feed-body">
            <div className="feed-title">{item.title}</div>
            <div className="feed-detail">{nameOf ? nameOf(item.actor) : short(item.actor, 14)} · {item.detail}</div>
          </div>
          <time className="feed-time" dateTime={item.at} title={new Date(item.at).toLocaleString()}>{ago(item.at)}</time>
        </li>
      ))}
    </ol>
  );
}

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "cyan" | "amber" | "red" | undefined }) {
  return (
    <div className={`kpi${tone ? ` kpi-${tone}` : ""}`}>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {hint ? <span className="kpi-hint">{hint}</span> : null}
    </div>
  );
}

export function PanelLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link className="panel-link" to={to}>{children} <Icon name="arrow" size={14} /></Link>;
}

/** An agent's state, from the chain record: fired, paused, without a role, working (last 24 h) or idle. */
export function agentState(agent: { active: boolean; nearAccountId: string; name: string }, roles: RoleView[], feed: FeedItem[], paused: boolean): AgentState {
  if (!agent.active) return "fired";
  if (!roles.some((role) => role.members.some((member) => member.member === agent.nearAccountId))) return "no role";
  if (paused) return "paused";
  const recent = feed.find((item) => item.actor === agent.nearAccountId || item.actor === agent.name);
  return recent && Date.now() - new Date(recent.at).getTime() < 86_400_000 ? "working" : "idle";
}
