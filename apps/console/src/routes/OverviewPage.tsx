import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { api, type AgentRow } from "../api.js";
import { Avatar, BudgetGauge, Feed, Icon, Kpi, PanelLink, StateDot, agentState, ago, feedOf, until } from "../components/ops.js";
import { Card, PageState, Status, short } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { formatAmount, omni } from "../omniroles-api.js";
import { TreasuryChecks } from "./TreasurySetup.js";

/** The command center: who works, what happened, what waits for the owners. */
export function OverviewPage() {
  const wallets = useWallets();
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status, refetchInterval: 15_000 });
  const ready = Boolean(status.data?.treasury);
  const roles = useQuery({ queryKey: ["omni-roles"], queryFn: omni.roles, enabled: ready, refetchInterval: 15_000 });
  const governance = useQuery({ queryKey: ["omni-governance"], queryFn: omni.governance, enabled: ready, refetchInterval: 15_000 });
  const activity = useQuery({ queryKey: ["omni-activity"], queryFn: omni.activity, enabled: ready, refetchInterval: 15_000 });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ agents: AgentRow[] }>("/v1/console/agents"), enabled: ready, refetchInterval: 15_000 });
  const me = wallets.nearAccountId;
  const paused = status.data?.paused ?? false;
  const roleList = roles.data?.roles ?? [];
  const feed = feedOf(activity.data);
  const waiting = (governance.data?.proposals ?? []).filter((proposal) => proposal.status === "InProgress");
  const myVotes = waiting.filter((proposal) => !(me && me in proposal.votes)).length;
  const pendingRules = (governance.data?.rules ?? []).filter((rule) => rule.state === "Queued");
  const refused = (activity.data?.requests ?? []).filter((item) => item.kind === "refusal").length;
  const executed = (activity.data?.operations ?? []).filter((item) => item.evm?.status === "success" || (item.solana && item.vaultState === "Confirmed")).length;
  const staff = (agents.data?.agents ?? []).filter((agent) => agent.active);
  const states = staff.map((agent) => agentState(agent, roleList, feed, paused));
  const working = states.filter((state) => state === "working").length;
  const nameOf = (actor: string) => staff.find((agent) => agent.nearAccountId === actor || agent.name === actor)?.name ?? short(actor, 14);
  const holdings = useQuery({ queryKey: ["omni-holdings"], queryFn: omni.holdings, enabled: ready, refetchInterval: 30_000 });
  const assets = (holdings.data?.chains ?? []).flatMap((chain) => chain.assets);
  const balance = !status.data?.wallet ? "no wallet"
    : holdings.isLoading ? "…"
    : assets.length === 0 ? "empty"
    : <span className="kpi-list">{assets.slice(0, 3).map((asset) => <span key={`${asset.symbol}-${asset.where}`}>{formatAmount(asset.amount, asset.symbol)}</span>)}{assets.length > 3 ? <span className="small">+{assets.length - 3} more</span> : null}</span>;
  const chainCount = (holdings.data?.chains ?? []).length;

  const loading = ready && (roles.isLoading || governance.isLoading || activity.isLoading);
  const next = loading ? null
    : !status.data?.treasury ? { title: "Finish the company setup", detail: "Members, treasury and wallet.", action: "Continue setup", to: "/onboarding" }
    : !status.data.wallet ? { title: "Create the company wallet", detail: "Members vote on the DAO's first decision.", action: "Continue setup", to: "/onboarding" }
    : roleList.length === 0 ? { title: "Write the first role", detail: "Say what agents may do, with which budget.", action: "New role", to: "/roles?new=1" }
    : staff.length === 0 ? { title: "Hire the first AI employee", detail: "It gets a NEAR account that can only ask the vault.", action: "Hire an agent", to: "/agents" }
    : myVotes > 0 ? { title: `${myVotes} decision${myVotes > 1 ? "s" : ""} waiting for your vote`, detail: "Read what changes, then approve or reject.", action: "Open decisions", to: "/governance" }
    : null;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Command center</span>
          <h1>Overview</h1>
          <p className="muted">Your AI employees, what they did, and what waits for the owners.</p>
        </div>
        {ready ? <Link className="button primary" to="/agents">Hire an agent</Link> : null}
      </header>
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
            <div className="kpis">
              <Kpi label="Treasury" value={<Link to="/wallet" className="kpi-link">{balance}</Link>} hint={status.data.wallet ? `${assets.length} asset${assets.length === 1 ? "" : "s"} on ${chainCount} chain${chainCount === 1 ? "" : "s"} · details in Wallet` : "create the wallet"} />
              <Kpi label="AI employees" value={loading ? "…" : `${working} / ${staff.length}`} hint={paused ? "all paused" : "working in the last 24 h"} tone="cyan" />
              <Kpi label="Executed on chain" value={loading ? "…" : executed} hint="signed by the vault, mined" />
              <Kpi label="Refused" value={loading ? "…" : refused} hint="outside a role, or failed checks" tone={refused ? "red" : undefined} />
              <Kpi label="Waiting for votes" value={loading ? "…" : waiting.length} hint={`${pendingRules.length} rule${pendingRules.length === 1 ? "" : "s"} in veto window`} tone={waiting.length ? "amber" : undefined} />
            </div>

            <div className="ops-grid">
              <section className="panel">
                <header className="panel-head"><h2>AI employees</h2><PanelLink to="/agents">Manage</PanelLink></header>
                {agents.isLoading ? <div className="state">Loading…</div> : staff.length === 0 ? <div className="state">No AI employee yet.</div> : (
                  <ul className="roster">
                    {staff.map((agent, index) => {
                      const held = roleList.filter((role) => role.members.some((member) => member.member === agent.nearAccountId));
                      const last = feed.find((item) => item.actor === agent.nearAccountId || item.actor === agent.name);
                      const budget = held.flatMap((role) => role.budgets.map((item) => ({ role: role.name, item })))[0];
                      return (
                        <li key={agent.id}>
                          <Avatar name={agent.name} seed={agent.nearAccountId} />
                          <div className="roster-who">
                            <strong>{agent.name}</strong>
                            <span className="chips">{held.length ? held.map((role) => <span key={role.name} className="chip-role">{role.name}</span>) : <span className="chip-role none">no role</span>}</span>
                          </div>
                          <div className="roster-budget">{budget ? <BudgetGauge role={budget.role} budget={budget.item} /> : <span className="muted small">No budget</span>}</div>
                          <div className="roster-last">
                            <StateDot state={states[index]!} />
                            <span className="small muted">{last ? `${last.ok ? "" : "refused · "}${last.title} · ${ago(last.at)}` : "no activity yet"}</span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section className="panel">
                <header className="panel-head"><h2>Live activity</h2><PanelLink to="/activity">All</PanelLink></header>
                {activity.isLoading ? <div className="state">Loading…</div> : <Feed items={feed} limit={7} nameOf={nameOf} />}
              </section>

              <section className="panel">
                <header className="panel-head"><h2>Waiting for votes</h2><PanelLink to="/governance">Decisions</PanelLink></header>
                {waiting.length === 0 && pendingRules.length === 0 ? <div className="state">Nothing to vote on.</div> : (
                  <ul className="votes-list">
                    {waiting.map((proposal) => (
                      <li key={proposal.id}>
                        <span className="mono small muted">#{proposal.id}</span>
                        <span className="votes-title">{proposal.title}</span>
                        {me && me in proposal.votes ? <span className="status status-approved">voted</span> : <span className="status status-pending">your vote</span>}
                      </li>
                    ))}
                    {pendingRules.map((rule) => (
                      <li key={rule.queueId}>
                        <span className="mono small muted">veto</span>
                        <span className="votes-title">{rule.title}</span>
                        <span className="small muted">applies {until(rule.activatesAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="panel">
                <header className="panel-head"><h2>Budgets</h2><PanelLink to="/roles">Roles</PanelLink></header>
                {roles.isLoading ? <div className="state">Loading…</div> : roleList.flatMap((role) => role.budgets).length === 0 ? <div className="state">No budget yet.</div> : (
                  <div className="gauges">
                    {roleList.flatMap((role) => role.budgets.map((budget) => <BudgetGauge key={`${role.name}-${budget.key}`} role={role.name} budget={budget} />))}
                  </div>
                )}
              </section>
            </div>

            <Card title="Company on chain" action={<Status value={status.data.treasury.status === "active" ? "active" : "pending"} />}>
              <div className="explain">
                <div><span className="eyebrow">DAO</span><strong className="mono small">{status.data.treasury.daoAccountId}</strong></div>
                <div><span className="eyebrow">Vault</span><strong className="mono small">{status.data.treasury.vaultAccountId}</strong></div>
              </div>
              <TreasuryChecks status={status.data} />
            </Card>
          </>
        ) : null}
      </PageState>
    </div>
  );
}
