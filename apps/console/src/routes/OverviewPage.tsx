import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { api, type AgentRow } from "../api.js";
import { Avatar, Icon, PanelLink, ago, until } from "../components/ops.js";
import { PageState, short } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { OUTCOME_LABEL, entriesOf, formatToken, formatUsd, roleName, tokenName } from "../lib/money.js";
import { marketConsole, tokenAmount } from "../lib/market.js";
import { omni, type RoleView } from "../omniroles-api.js";

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
  const rows = chains.flatMap((chain) => chain.assets.map((asset) => ({ ...asset, chain: chain.chain })))
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const unpriced = rows.some((row) => row.usd === null);

  const loading = ready && (roles.isLoading || governance.isLoading || activity.isLoading);
  const next = loading ? null
    : !status.data?.treasury ? { title: "Finish the company setup", detail: "Members, vault and wallet.", action: "Continue setup", to: "/onboarding" }
    : !status.data.wallet ? { title: "Create the company wallet", detail: "Members vote on it: it is the company's first decision.", action: "Continue setup", to: "/onboarding" }
    : roleList.length === 0 ? { title: "Write the first rule", detail: "Say what an agent may do, and with which budget.", action: "New rule", to: "/roles?new=1" }
    : staff.length === 0 ? { title: "Add your first AI agent", detail: "It can only ask the vault, within its rules.", action: "Add an agent", to: "/agents" }
    : null;

  return (
    <div className="page home">
      <PageState loading={status.isLoading} error={status.error}>
        {next ? (
          <div className="next-banner">
            <Icon name="arrow" />
            <div><strong>{next.title}</strong><span>{next.detail}</span></div>
            <Link className="button primary" to={next.to}>{next.action}</Link>
          </div>
        ) : null}

        {status.data?.treasury ? (
          <>
            <section className="balance-hero" aria-label="Total balance">
              <div className="balance-main">
                <span className="balance-label">Total balance</span>
                <strong className="balance-value">{holdings.isLoading ? "…" : !status.data.wallet ? formatUsd(0) : formatUsd(holdings.data?.totalUsd ?? 0)}</strong>
                <span className="balance-hint">
                  {chains.length ? `On ${chains.map((chain) => chain.chain).join(" and ")}` : "No wallet yet"} · indicative prices{unpriced ? ", test tokens not counted" : ""}
                </span>
              </div>
              <div className="balance-actions">
                <Link className="button primary" to="/wallet">Deposit</Link>
                <Link className="button secondary" to="/wallet">Treasury details</Link>
              </div>
            </section>

            {myVotes > 0 ? (
              <Link to="/governance" className="vote-callout">
                <span className="vote-count">{myVotes}</span>
                <span><strong>{myVotes === 1 ? "A decision is" : `${myVotes} decisions are`} waiting for your vote</strong><span>Nothing changes until members approve.</span></span>
                <Icon name="arrow" />
              </Link>
            ) : null}

            <div className="home-grid">
              <div className="home-col">
                <section className="panel">
                  <header className="panel-head"><h2>Assets</h2><PanelLink to="/wallet">Treasury</PanelLink></header>
                  {holdings.isLoading ? <div className="state">Loading…</div> : rows.length === 0 ? (
                    <div className="state">No funds yet. <Link to="/wallet">Deposit</Link> to the company wallet to get started.</div>
                  ) : (
                    <table className="assets">
                      <thead><tr><th>Asset</th><th className="num">Amount</th><th className="num">Value</th></tr></thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={`${row.chain}-${row.symbol}-${row.where}`}>
                            <td>
                              <span className="asset">
                                <span className="token-badge" aria-hidden="true">{tokenName(row.symbol).slice(0, 1)}</span>
                                <span><strong>{tokenName(row.symbol)}</strong><span className="asset-where">{row.chain}{row.where !== "wallet" ? ` · ${row.where}` : ""}</span></span>
                              </span>
                            </td>
                            <td className="num">{formatToken(row.amount)}</td>
                            <td className="num">{row.usd === null ? <span className="muted">test token</span> : formatUsd(row.usd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>

                <section className="panel">
                  <header className="panel-head"><h2>Recent activity</h2><PanelLink to="/activity">See all</PanelLink></header>
                  {activity.isLoading ? <div className="state">Loading…</div> : entries.length === 0 ? (
                    <div className="state">Nothing yet. Every payment, swap or refusal shows up here.</div>
                  ) : (
                    <ul className="tx-list">
                      {entries.slice(0, 6).map((entry) => (
                        <li key={entry.id}>
                          <Link to="/activity" className="tx-row">
                            <span className={`tx-icon ${entry.outcome}`}><Icon name={entry.outcome === "refused" || entry.outcome === "failed" ? "cross" : entry.outcome === "pending" ? "setup" : "check"} size={15} /></span>
                            <span className="tx-text">
                              <strong>{entry.text}</strong>
                              <span>{nameOf(entry.actor)}{entry.chain ? ` · ${entry.chain}` : ""} · {ago(entry.at)}</span>
                            </span>
                            <span className={`outcome outcome-${entry.outcome}`}>{OUTCOME_LABEL[entry.outcome]}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>

              <div className="home-col">
                {sales.data || purchases.data ? (
                  <section className="panel">
                    <header className="panel-head"><h2>Market</h2><PanelLink to="/selling">Open</PanelLink></header>
                    <table className="assets">
                      <tbody>
                        <tr><td><strong>Sales</strong><span className="asset-where"> · {sales.data?.sales.length ?? 0} orders</span></td><td className="num">{tokenAmount(sales.data?.revenueAtomic ?? "0")} USDC</td></tr>
                        <tr><td><strong>Purchases</strong><span className="asset-where"> · by your agents</span></td><td className="num">{tokenAmount(purchases.data?.spentAtomic ?? "0")} USDC</td></tr>
                      </tbody>
                    </table>
                  </section>
                ) : null}
                <section className="panel">
                  <header className="panel-head"><h2>Votes</h2><PanelLink to="/governance">Open</PanelLink></header>
                  {waiting.length === 0 && pendingRules.length === 0 ? <div className="state">Nothing to vote on.</div> : (
                    <ul className="votes-list">
                      {waiting.map((proposal) => (
                        <li key={proposal.id}>
                          <span className="votes-title">{proposal.title}</span>
                          {me && me in proposal.votes ? <span className="outcome outcome-done">Voted</span> : <span className="outcome outcome-pending">Your vote</span>}
                        </li>
                      ))}
                      {pendingRules.map((rule) => (
                        <li key={rule.queueId}>
                          <span className="votes-title">{rule.title}</span>
                          <span className="small muted">applies {until(rule.activatesAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="panel">
                  <header className="panel-head"><h2>AI agents</h2><PanelLink to="/agents">Manage</PanelLink></header>
                  {agents.isLoading ? <div className="state">Loading…</div> : staff.length === 0 ? <div className="state">No agent yet.</div> : (
                    <ul className="agent-list">
                      {staff.map((agent) => {
                        const held = roleList.filter((role) => role.members.some((member) => member.member === agent.nearAccountId));
                        const last = entries.find((entry) => entry.actor === agent.nearAccountId || entry.actor === agent.name);
                        return (
                          <li key={agent.id}>
                            <Avatar name={agent.name} seed={agent.nearAccountId} size={36} />
                            <div className="agent-body">
                              <div className="agent-line">
                                <strong>{agent.name}</strong>
                                <span className="muted small">{held.length ? held.map((role) => roleName(role.name)).join(", ") : "No rule yet"}</span>
                              </div>
                              {held.flatMap((role) => role.budgets).slice(0, 2).map((budget) => <Allowance key={budget.key} budget={budget} />)}
                              <span className="small muted">{last ? `Last: ${last.text.charAt(0).toLowerCase()}${last.text.slice(1)} · ${ago(last.at)}` : "No activity yet"}</span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </div>
            </div>
          </>
        ) : null}
      </PageState>
    </div>
  );
}

/** "12 USDC left of 50 this week". */
function Allowance({ budget }: { budget: RoleView["budgets"][number] }) {
  const available = Number(budget.available ?? 0);
  const max = Number(budget.max ?? 0);
  const left = max > 0 ? Math.max(0, Math.min(100, Math.round((available / max) * 100))) : 0;
  const period = budget.periodDays === 1 ? "today" : budget.periodDays === 7 ? "this week" : budget.periodDays === 30 ? "this month" : `per ${budget.periodDays} days`;
  const token = budget.token ? tokenName(budget.token) : "";
  return (
    <div className="allowance">
      <div className={`bar${left === 0 ? " empty" : left < 25 ? " low" : ""}`} role="img" aria-label={`${left}% left`}><span style={{ width: `${left}%` }} /></div>
      <span className="small"><strong>{formatToken(available)} {token}</strong> <span className="muted">left of {formatToken(max)} {period}</span></span>
    </div>
  );
}
