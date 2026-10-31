/**
 * Company HQ. Visual reference: design-handoff/app/source/01-hq.html and
 * 11-hq-paused.html (screens 01 and 11).
 * Treasury as fluted columns per chain, votes waiting, agents in their niches
 * with their budgets, and the verdict feed. Data and handlers are main's.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { api, type AgentRow } from "../api.js";
import { PanelLink, ago, until } from "../components/ops.js";
import { PageState, short } from "../components/ui.js";
import { chainLabel, ColumnGauge, Kicker, Niche, PageTitle, Seal, SectionHead, Slab } from "../components/design.js";
import { useWallets } from "../lib/wallet-context.js";
import { OUTCOME_LABEL, entriesOf, formatToken, formatUsd, roleName, tokenName } from "../lib/money.js";
import { marketConsole, tokenAmount } from "../lib/market.js";
import { omni, type RoleView } from "../omniroles-api.js";
import "../styles/app.css";

const SEAL_OF: Record<string, string> = { done: "SIGNED", pending: "PENDING", failed: "FAILED", refused: "REFUSED", cancelled: "EXPIRED" };

/** Home: how much the company holds, what moved, what waits for you. */
export function OverviewPage() {
  const wallets = useWallets();
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status, refetchInterval: 15_000 });
  const ready = Boolean(status.data?.treasury);
  const roles = useQuery({ queryKey: ["omni-roles"], queryFn: omni.roles, enabled: ready, refetchInterval: 15_000 });
  const governance = useQuery({ queryKey: ["omni-governance"], queryFn: omni.governance, enabled: ready, refetchInterval: 15_000 });
  const activity = useQuery({ queryKey: ["omni-activity"], queryFn: omni.activity, enabled: ready, refetchInterval: 15_000 });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ agents: AgentRow[] }>("/v1/console/agents"), enabled: ready, refetchInterval: 15_000 });
  const holdings = useQuery({ queryKey: ["omni-holdings"], queryFn: omni.holdings, enabled: ready, refetchInterval: 30_000 });

  // The market is optional on an API: no panel when it is not enabled.
  const sales = useQuery({ queryKey: ["market-sales"], queryFn: marketConsole.sales, enabled: ready, retry: false, refetchInterval: 30_000 });
  const purchases = useQuery({ queryKey: ["market-purchases"], queryFn: marketConsole.purchases, enabled: ready, retry: false, refetchInterval: 30_000 });
  const me = wallets.nearAccountId;
  const roleList = roles.data?.roles ?? [];
  const staff = (agents.data?.agents ?? []).filter((agent) => agent.active);
  const nameOf = (actor: string) => staff.find((agent) => agent.nearAccountId === actor || agent.name === actor)?.name ?? short(actor, 14);
  const entries = entriesOf(activity.data);
  const waiting = (governance.data?.proposals ?? []).filter((proposal) => proposal.status === "InProgress");
  const myVotes = waiting.filter((proposal) => !(me && me in proposal.votes)).length;
  const pendingRules = (governance.data?.rules ?? []).filter((rule) => rule.state === "Queued");
  const chains = holdings.data?.chains ?? [];
  const rows = chains.flatMap((chain) => chain.assets.map((asset) => ({ ...asset, chain: chain.chain }))).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const unpriced = rows.some((row) => row.usd === null);
  const byChain = chains
    .map((chain) => ({ chain: chain.chain, usd: chain.assets.reduce((sum, asset) => sum + (asset.usd ?? 0), 0) }))
    .sort((a, b) => b.usd - a.usd);
  const maxChain = Math.max(1, ...byChain.map((item) => item.usd));

  const loading = ready && (roles.isLoading || governance.isLoading || activity.isLoading);
  const next = loading
    ? null
    : !status.data?.treasury
      ? { title: "Finish the company setup", detail: "Members, vault and wallet.", action: "Continue setup", to: "/onboarding" }
      : !status.data.wallet
        ? { title: "Create the company wallet", detail: "Members vote on it: it is the company's first decision.", action: "Continue setup", to: "/onboarding" }
        : roleList.length === 0
          ? { title: "Write the first rule", detail: "Say what an agent may do, and with which budget.", action: "New rule", to: "/roles?new=1" }
          : staff.length === 0
            ? { title: "Add your first AI agent", detail: "It can only ask the vault, within its rules.", action: "Add an agent", to: "/agents" }
            : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <PageState loading={status.isLoading} error={status.error}>
        {next ? (
          <div className="ori-panel" style={{ padding: "18px 22px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <b style={{ font: "800 17px var(--font-brand)", letterSpacing: ".06em" }}>{next.title}</b>
              <span style={{ fontSize: 13.5, color: "#3A1608" }}>{next.detail}</span>
            </div>
            <Link to={next.to} className="btn-line" style={{ marginLeft: "auto", borderColor: "rgba(32,10,3,.45)", color: "#200A03" }}>
              {next.action.toUpperCase()}
            </Link>
          </div>
        ) : null}

        {status.data?.treasury ? (
          <>
            <div className="g2" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.35fr) minmax(0, 1fr)", gap: 22 }}>
              <section
                className="ori-panel"
                style={{ padding: "26px 28px", display: "flex", flexDirection: "column", gap: 14, boxShadow: "16px 20px 44px rgba(90,30,10,.28), inset 2px 0 0 rgba(255,228,180,.35)" }}
                aria-label="Total balance"
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <Kicker color="rgba(32,10,3,.7)">Treasury</Kicker>
                  <Link to="/wallet" className="section-link" style={{ color: "#200A03" }}>
                    WALLETS →
                  </Link>
                </div>
                <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ font: "700 54px/1 var(--font-mono)", color: "rgba(32,10,3,.85)", textShadow: "0 1px 0 rgba(255,222,170,.55), 0 -1px 0 rgba(30,6,0,.4)" }}>
                      {holdings.isLoading ? "…" : !status.data.wallet ? formatUsd(0) : formatUsd(holdings.data?.totalUsd ?? 0)}
                    </div>
                    <p style={{ margin: "8px 0 0", fontSize: 13.5, color: "#3A1608", maxWidth: 280 }}>
                      {chains.length ? `On ${chains.map((chain) => chain.chain).join(", ")}.` : "No wallet yet."} Every wallet is derived from the vault and has no private key.
                      {unpriced ? " Test tokens are not counted." : ""}
                    </p>
                  </div>
                  {byChain.length > 0 ? (
                    <div style={{ display: "flex", alignItems: "flex-end", gap: 14, height: 140 }} role="img" aria-label={`Holdings by chain: ${byChain.map((item) => `${item.chain} ${formatUsd(item.usd)}`).join(", ")}`}>
                      {byChain.slice(0, 4).map((item) => (
                        <ColumnGauge key={item.chain} value={item.usd} max={maxChain} label={chainLabel(item.chain)} amount={formatUsd(item.usd)} height={Math.max(24, Math.round((item.usd / maxChain) * 104))} />
                      ))}
                    </div>
                  ) : null}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, borderTop: "1px solid rgba(32,10,3,.25)", paddingTop: 12, fontSize: 13, color: "#2A0D04" }}>
                  <span style={{ width: 18, height: 18, borderRadius: "50%", background: "#200A03", color: "#FFE2A8", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}>✓</span>
                  Integrity: every transaction that left these wallets was signed through the vault.
                </div>
              </section>

              <Slab style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 4 }}>
                <SectionHead
                  left={<Kicker>Before the assembly</Kicker>}
                  right={
                    <Link to="/governance" className="section-link">
                      ALL VOTES →
                    </Link>
                  }
                />
                {myVotes > 0 ? (
                  <Link to="/governance" style={{ textDecoration: "none", color: "inherit", display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "4px 12px", padding: "12px 0", borderTop: "1px solid rgba(13,23,48,.12)" }}>
                    <b style={{ fontSize: 14.5 }}>
                      {myVotes === 1 ? "A decision is" : `${myVotes} decisions are`} waiting for your vote
                    </b>
                    <span className="app-seal" style={{ width: 32, height: 32 }} aria-hidden="true">
                      <span style={{ fontSize: 8 }}>VOTE</span>
                    </span>
                    <small style={{ color: "#4A5675" }}>Nothing changes until members approve.</small>
                  </Link>
                ) : null}
                {waiting.length === 0 && pendingRules.length === 0 ? <p className="empty-state" style={{ marginTop: 10 }}>No proposal is waiting for votes.</p> : null}
                {waiting.map((proposal) => (
                  <div key={proposal.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "4px 12px", padding: "12px 0", borderTop: "1px solid rgba(13,23,48,.12)" }}>
                    <b style={{ fontSize: 14.5 }}>{proposal.title}</b>
                    {me && me in proposal.votes ? (
                      <span style={{ font: "600 12px var(--font-mono)", color: "#4A5675", alignSelf: "start" }}>voted</span>
                    ) : (
                      <span style={{ font: "600 12px var(--font-mono)", background: "#FCF0D4", color: "#8A5A00", padding: "2px 8px", alignSelf: "start" }}>your vote</span>
                    )}
                    <small style={{ color: "#4A5675" }}>{Object.keys(proposal.votes).length} approved · waiting for the rest</small>
                  </div>
                ))}
                {pendingRules.map((rule) => (
                  <div key={rule.queueId} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "4px 12px", padding: "12px 0", borderTop: "1px solid rgba(13,23,48,.12)" }}>
                    <b style={{ fontSize: 14.5 }}>{rule.title}</b>
                    <span style={{ font: "600 12px var(--font-mono)", background: "#FCF0D4", color: "#8A5A00", padding: "2px 8px", alignSelf: "start" }}>{until(rule.activatesAt)}</span>
                    <small style={{ color: "#4A5675" }}>Rule change · veto window open</small>
                  </div>
                ))}
              </Slab>
            </div>

            <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <SectionHead
                left={<Kicker>The citizens · AI agents</Kicker>}
                right={
                  <Link to="/agents" className="section-link">
                    MANAGE AGENTS →
                  </Link>
                }
              />
              {agents.isLoading ? (
                <div className="loading-slab" style={{ minHeight: 120 }} />
              ) : staff.length === 0 ? (
                <Slab style={{ padding: 20 }}>
                  <p className="empty-state" style={{ margin: 0 }}>
                    No agent yet. <Link to="/agents">Add your first AI agent.</Link>
                  </p>
                </Slab>
              ) : (
                <div className="g3" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 18 }}>
                  {staff.map((agent) => {
                    const held = roleList.filter((role) => role.members.some((member) => member.member === agent.nearAccountId));
                    const last = entries.find((entry) => entry.actor === agent.nearAccountId || entry.actor === agent.name);
                    const paused = status.data?.paused ?? false;
                    return (
                      <Slab key={agent.id} as="article" style={{ padding: 16, display: "grid", gridTemplateColumns: "92px minmax(0,1fr)", gap: 16 }}>
                        <Niche role={held[0]?.name ?? "agent"} state={paused ? "paused" : "working"} height={132} />
                        <div style={{ display: "flex", flexDirection: "column", gap: 9, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                            <b style={{ font: "800 17px var(--font-brand)", letterSpacing: ".1em" }}>{agent.name.toUpperCase()}</b>
                            <span style={{ fontSize: 12, color: paused ? "var(--terra-ink)" : "var(--aegean-ink)", fontWeight: 700 }}>· {paused ? "paused" : "working"}</span>
                          </div>
                          <span style={{ fontSize: 13, color: "#4A5675" }}>{held.length ? held.map((role) => roleName(role.name)).join(", ") : "No rule yet"}</span>
                          {held.flatMap((role) => role.budgets).slice(0, 2).map((budget) => (
                            <Allowance key={budget.key} budget={budget} />
                          ))}
                          <span style={{ fontSize: 12, color: "#66718C" }}>{last ? `Last: ${last.text.charAt(0).toLowerCase()}${last.text.slice(1)} · ${ago(last.at)}` : "No activity yet"}</span>
                        </div>
                      </Slab>
                    );
                  })}
                </div>
              )}
            </section>

            <div className="g2" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, .85fr)", gap: 22, alignItems: "start" }}>
              <Slab style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 4 }}>
                <SectionHead
                  left={<Kicker>The verdicts</Kicker>}
                  right={
                    <Link to="/activity" className="section-link">
                      SEE ALL →
                    </Link>
                  }
                />
                {activity.isLoading ? (
                  <div className="loading-slab" style={{ marginTop: 10 }} />
                ) : entries.length === 0 ? (
                  <p className="empty-state" style={{ marginTop: 10 }}>Nothing yet. Every payment, swap or refusal shows up here.</p>
                ) : (
                  entries.slice(0, 5).map((entry) => (
                    <Link
                      key={entry.id}
                      to="/activity"
                      style={{ textDecoration: "none", color: "inherit", display: "grid", gridTemplateColumns: "34px minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "11px 0", borderTop: "1px solid rgba(13,23,48,.12)" }}
                    >
                      <Seal word={SEAL_OF[entry.outcome] ?? "PENDING"} size={32} tone={entry.outcome === "refused" || entry.outcome === "failed" ? "refused" : undefined} />
                      <span style={{ minWidth: 0 }}>
                        <b style={{ display: "block", fontSize: 14 }}>{entry.text}</b>
                        <span style={{ fontSize: 12, color: "#66718C" }}>
                          {nameOf(entry.actor)}
                          {entry.chain ? ` · ${entry.chain}` : ""} · {ago(entry.at)}
                        </span>
                      </span>
                      <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".14em", color: entry.outcome === "refused" || entry.outcome === "failed" ? "var(--terra-ink)" : "#4A5675" }}>
                        {OUTCOME_LABEL[entry.outcome].toUpperCase()}
                      </span>
                    </Link>
                  ))
                )}
              </Slab>

              <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
                {sales.data || purchases.data ? (
                  <Slab style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 10 }}>
                    <SectionHead
                      left={<Kicker color="var(--aegean-ink)">Euthyna Market</Kicker>}
                      right={
                        <Link to="/selling" className="section-link">
                          OPEN →
                        </Link>
                      }
                    />
                    <div className="row1" style={{ borderTop: 0 }}>
                      <span style={{ fontSize: 14 }}>
                        Sales <span style={{ color: "#66718C", fontSize: 12.5 }}>· {sales.data?.sales.length ?? 0} orders</span>
                      </span>
                      <b className="mono" style={{ font: "600 14px var(--font-mono)" }}>
                        {tokenAmount(sales.data?.revenueAtomic ?? "0")} USDC
                      </b>
                    </div>
                    <div className="row1">
                      <span style={{ fontSize: 14 }}>
                        Purchases <span style={{ color: "#66718C", fontSize: 12.5 }}>· by your agents</span>
                      </span>
                      <b style={{ font: "600 14px var(--font-mono)" }}>{tokenAmount(purchases.data?.spentAtomic ?? "0")} USDC</b>
                    </div>
                  </Slab>
                ) : null}

                <Slab style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 10 }}>
                  <Kicker>Treasury details</Kicker>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <Link to="/wallet" className="btn-ori">
                      DEPOSIT
                    </Link>
                    <Link to="/wallet" className="btn-line">
                      WALLETS
                    </Link>
                  </div>
                  {rows.length === 0 ? (
                    <p className="empty-state" style={{ margin: 0 }}>
                      No funds yet. <Link to="/wallet">Deposit</Link> to the company wallet to get started.
                    </p>
                  ) : (
                    rows.slice(0, 4).map((row) => (
                      <div key={`${row.chain}-${row.symbol}-${row.where}`} className="row1">
                        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <b style={{ font: "600 14px var(--font-mono)" }}>
                            {formatToken(row.amount)} {tokenName(row.symbol)}
                          </b>
                          <span style={{ fontSize: 12, color: "#66718C" }}>
                            {row.chain}
                            {row.where !== "wallet" ? ` · ${row.where}` : ""}
                          </span>
                        </span>
                        <span style={{ font: "600 13px var(--font-mono)", color: "#4A5675" }}>{row.usd === null ? "test token" : formatUsd(row.usd)}</span>
                      </div>
                    ))
                  )}
                </Slab>
              </div>
            </div>
          </>
        ) : null}
      </PageState>
    </div>
  );
}

/** "12 USDC left of 50 this week", as a marble groove. */
function Allowance({ budget }: { budget: RoleView["budgets"][number] }) {
  const available = Number(budget.available ?? 0);
  const max = Number(budget.max ?? 0);
  const left = max > 0 ? Math.max(0, Math.min(100, Math.round((available / max) * 100))) : 0;
  const period = budget.periodDays === 1 ? "today" : budget.periodDays === 7 ? "this week" : budget.periodDays === 30 ? "this month" : `per ${budget.periodDays} days`;
  const token = budget.token ? tokenName(budget.token) : "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: "#4A5675" }}>
        <span>
          {token} · {period}
        </span>
        <b style={{ font: "600 12px var(--font-mono)", color: "#0D1730" }}>
          {formatToken(available)} / {formatToken(max)}
        </b>
      </div>
      <div className="groove" role="img" aria-label={`${left}% left`}>
        <i style={{ width: `${left}%` }} />
      </div>
    </div>
  );
}
