/**
 * The console's design vocabulary, once: seals, slabs, night panels, statues,
 * columns, vote tokens, the veto ring and the agent's spending card.
 * Values and shapes come from design-handoff/app (tokens.css and the
 * components section of 00-consignes-app.md).
 */
import type { CSSProperties, ReactNode } from "react";

import "../styles/app.css";

export type SealWord =
  | "SIGNED" | "REFUSED" | "PENDING" | "SETTLED" | "HELD" | "SETTLING"
  | "EXPIRED" | "APPLIED" | "VETOED" | "INTACT" | "PAID" | "FAILED"
  | "WORKING" | "DELIVERED" | "QUEUED" | "CO-SIGN";

const SIZES = { 32: 8, 38: 7.5, 44: 7.5, 52: 7, 80: 11 } as const;

/** A struck bronze seal. Refused words tilt towards terracotta. */
export function Seal({ word, size = 44, tone }: { word: SealWord | string; size?: keyof typeof SIZES | number; tone?: "refused" | "expired" | undefined }) {
  const pixels = typeof size === "number" ? size : Number(size);
  const refused = tone === "refused" || word === "REFUSED" || word === "VETOED" || word === "FAILED";
  const fontSize = SIZES[(pixels as keyof typeof SIZES)] ?? Math.max(6, pixels / 7);
  return (
    <div className={`app-seal${refused ? " refused" : ""}${tone === "expired" ? " expired" : ""}${pixels >= 72 ? " big" : ""}`} style={{ width: pixels, height: pixels }} role="img" aria-label={word}>
      <span style={{ fontSize }}>{word}</span>
    </div>
  );
}

export function Slab({ children, style, className = "", as: Tag = "section" }: { children: ReactNode; style?: CSSProperties; className?: string; as?: "section" | "article" | "div" }) {
  return (
    <Tag className={`slab ${className}`} style={style}>
      {children}
    </Tag>
  );
}

export function NightPanel({ children, style, className = "" }: { children: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <section className={`night-panel ${className}`} style={style}>
      {children}
    </section>
  );
}

export function Kicker({ children, color, style }: { children: ReactNode; color?: string; style?: CSSProperties }) {
  return (
    <span className="app-kick" style={{ color: color ?? "var(--gold-ink)", ...style }}>
      {children}
    </span>
  );
}

export function PageTitle({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <h1 className="page-title" style={style}>
      {children}
    </h1>
  );
}

export function SectionHead({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <div className="section-head">
      {left}
      {right}
    </div>
  );
}

/** One statue per role: payments → Naomi, treasury → Thetis, revenue → Hermes. */
export function Niche({ role, state = "working", height = 132, width }: { role: string; state?: "working" | "idle" | "paused"; height?: number; width?: CSSProperties["width"] }) {
  const name = role.toLowerCase();
  const base = name.includes("pay") ? "statue" : name.includes("treasur") ? "statue-t" : name.includes("revenu") ? "statue-h" : "statue";
  return (
    <div className="niche" style={{ height, width }}>
      <div className={`${base}${state === "idle" ? " idle" : ""}${state === "paused" ? " paused" : ""}`} style={{ width: "100%", height: "100%", borderRadius: 0, boxShadow: "none" }} role="img" aria-label={`${role} statue`} />
    </div>
  );
}

/** A fluted column filled to `value / max`. */
export function ColumnGauge({ value, max, label, amount, height = 104 }: { value: number; max: number; label: string; amount: string; height?: number }) {
  const filled = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <span style={{ font: "600 11px var(--font-mono)" }}>{amount}</span>
      <div style={{ width: 34, height, position: "relative", background: "rgba(13,23,48,.08)", boxShadow: "inset 0 0 0 1px rgba(13,23,48,.15)" }}>
        <div className="col" style={{ position: "absolute", inset: "auto 0 0 0", height: `${Math.max(6, filled * 100)}%` }} />
      </div>
      <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".12em" }}>{label}</span>
    </div>
  );
}

/** One bronze token per vote: filled for yes, empty for still to come. */
export function VoteTokens({ votes, total }: { votes: number; total: number }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }} aria-label={`${votes} of ${total} votes`}>
      {Array.from({ length: total }, (_, index) => (
        <span key={index} className={`token${index < votes ? "" : " empty"}`} />
      ))}
    </span>
  );
}

/** The orichalcum ring that shows how much of the veto window is left. */
export function VetoRing({ remaining, total, size = 64 }: { remaining: number; total: number; size?: number }) {
  const radius = size / 2 - 5;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="veto-ring" role="img" aria-label="Veto window remaining">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(242,181,68,.18)" strokeWidth="5" />
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#F2B544" strokeWidth="5" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)} />
    </svg>
  );
}

/** The agent's spending card: orichalcum, the balance in mono. */
export function SpendingCard({ agent, balance, symbol = "USDC", note }: { agent: string; balance: string; symbol?: string; note?: string }) {
  return (
    <div className="spending-card" style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 10, minWidth: 240 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <Kicker color="rgba(32,10,3,.7)">Spending card</Kicker>
        <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".16em" }}>TESTNET</span>
      </div>
      <b style={{ font: "800 18px var(--font-brand)", letterSpacing: ".1em" }}>{agent.toUpperCase()}</b>
      <div style={{ font: "700 28px/1 var(--font-mono)", textShadow: "0 1px 0 rgba(255,222,170,.55)" }}>
        {balance} <span style={{ fontSize: 13 }}>{symbol}</span>
      </div>
      {note ? <span style={{ fontSize: 12, color: "#3A1608" }}>{note}</span> : null}
    </div>
  );
}
