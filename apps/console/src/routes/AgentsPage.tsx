import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { decodeVaultCalls } from "@mandateos/sdk/roles";

import { api, type AgentRow } from "../api.js";
import { Avatar, BudgetGauge, StateDot, agentState, ago, feedOf, type AgentState } from "../components/ops.js";
import { Card, PageState, short } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type ProposalDraft, type RoleView } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";
import { NewAgent, RunYourAgent, type AgentReady } from "./AgentSetup.js";

/**
 * The company's staff. Each agent shows its jobs, what it did and what was
 * refused. Founders (and shareholders, on company calls) decide by vote:
 * hire for a job, change a budget, fire.
 */
export function AgentsPage() {
  const queryClient = useQueryClient();
  const wallets = useWallets();
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status });
  const roles = useQuery({ queryKey: ["omni-roles"], queryFn: omni.roles, enabled: Boolean(status.data?.treasury), refetchInterval: 15_000 });
  const activity = useQuery({ queryKey: ["omni-activity"], queryFn: omni.activity, enabled: Boolean(status.data?.treasury), refetchInterval: 20_000 });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ agents: AgentRow[] }>("/v1/console/agents"), refetchInterval: 10_000 });
  const [ready, setReady] = useState<AgentReady | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const treasury = status.data?.treasury;
  const me = wallets.nearAccountId;

  /** The server prepares the vote; the browser checks it says exactly this before the wallet signs. */
  async function propose(label: string, draft: () => Promise<ProposalDraft>, expected: (draft: ProposalDraft) => boolean) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const proposal = await draft();
      if (!treasury || proposal.receiverId !== treasury.daoAccountId || !expected(proposal)) {
        throw new Error("The server returned an unexpected proposal: nothing was signed.");
      }
      const result = await signDaoProposal(me, proposal);
      setNotice(`Proposal #${result.proposalId} submitted: ${proposal.title}. It applies once voted and out of the veto window.`);
      await queryClient.invalidateQueries({ queryKey: ["omni-governance"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }
  const callsOf = (proposal: ProposalDraft) => (treasury
    ? decodeVaultCalls(proposal.args.proposal.kind as Parameters<typeof decodeVaultCalls>[0], treasury.vaultAccountId) ?? []
    : []);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Staff</span>
          <h1>Agents</h1>
          <p className="muted">
            Agents work inside the roles the owners voted. Their record is read from the chains: what they did, what the vault
            or the Guard refused. Any council member can hire (up to 5 agents waiting for a role each); the owners give roles, change budgets and fire, by vote.
          </p>
        </div>
        {treasury && !adding ? <button className="primary" onClick={() => setAdding(true)}>Hire an agent</button> : null}
      </header>
      {error ? <div className="alert error">{error}</div> : null}
      {notice ? <div className="alert success">{notice}</div> : null}
      {!treasury ? <div className="state empty-action">Create the company first. <Link className="button primary" to="/onboarding">Continue setup</Link></div> : null}
      {ready && treasury ? <RunYourAgent agent={ready} vaultAccountId={treasury.vaultAccountId} onDone={() => setReady(null)} /> : null}
      {treasury && adding ? (
        <Card title="Hire an agent" action={<button className="ghost" onClick={() => setAdding(false)}>Close</button>}>
          <NewAgent
            vaultAccountId={treasury.vaultAccountId}
            onReady={(agent) => {
              setReady(agent);
              setAdding(false);
              void queryClient.invalidateQueries({ queryKey: ["agents"] });
            }}
          />
        </Card>
      ) : null}
      <PageState loading={agents.isLoading} error={agents.error} empty={agents.data?.agents.length === 0} emptyContent={<div className="state">No agent yet.</div>}>
        <div className="staff-grid">
          {(agents.data?.agents ?? []).slice().sort((a, b) => Number(b.active) - Number(a.active)).map((agent) => {
            const jobs = (roles.data?.roles ?? []).filter((role) => role.members.some((member) => member.member === agent.nearAccountId));
            const isAgent = (actor: string) => actor === agent.name || actor === agent.nearAccountId;
            const done = (activity.data?.operations ?? []).filter((operation) => isAgent(operation.actor));
            const executed = done.filter((operation) => operation.evm?.status === "success");
            const refused = (activity.data?.requests ?? []).filter((request) => request.kind === "refusal" && isAgent(request.agent));
            const feed = feedOf(activity.data);
            const lastItem = feed.find((item) => isAgent(item.actor));
            return (
              <StaffCard
                key={agent.id}
                agent={agent}
                jobs={jobs}
                allJobs={roles.data?.roles ?? []}
                executed={executed.length}
                refused={refused.length}
                last={lastItem ? `${lastItem.ok ? "" : "Refused · "}${lastItem.title} · ${ago(lastItem.at)}` : null}
                state={agentState(agent, roles.data?.roles ?? [], feed, status.data?.paused ?? false)}
                busy={busy}
                canPropose={Boolean(me) && !busy}
                onFire={() => void propose(`fire-${agent.id}`, () => omni.fireProposal(agent.nearAccountId), (proposal) =>
                  callsOf(proposal).length === jobs.length
                  && callsOf(proposal).every((call) => call.method === "queue_rule_change" && "RevokeMembership" in call.change && call.change.RevokeMembership.member === agent.nearAccountId))}
                onHire={(role) => void propose(`hire-${agent.id}`, () => omni.membershipProposal({ role, member: agent.nearAccountId, kind: "Agent", action: "grant" }), (proposal) => {
                  const calls = callsOf(proposal);
                  return calls.length === 1 && calls[0]!.method === "queue_rule_change" && "GrantMembership" in calls[0]!.change
                    && calls[0]!.change.GrantMembership.member === agent.nearAccountId && calls[0]!.change.GrantMembership.role === role;
                })}
                onBudget={(key, amount) => void propose(`budget-${agent.id}`, () => omni.budgetProposal(key, amount), (proposal) => {
                  const calls = callsOf(proposal);
                  return calls.length === 1 && calls[0]!.method === "queue_rule_change" && "SetAllowance" in calls[0]!.change
                    && `0x${calls[0]!.change.SetAllowance.key.map((byte) => byte.toString(16).padStart(2, "0")).join("")}` === key.toLowerCase();
                })}
              />
            );
          })}
        </div>
      </PageState>
    </div>
  );
}

function StaffCard(props: {
  agent: AgentRow;
  jobs: RoleView[];
  allJobs: RoleView[];
  executed: number;
  refused: number;
  last: string | null;
  state: AgentState;
  busy: string | null;
  canPropose: boolean;
  onFire: () => void;
  onHire: (role: string) => void;
  onBudget: (key: string, amount: string) => void;
}) {
  const { agent, jobs } = props;
  const [hireFor, setHireFor] = useState("");
  const [budgets, setBudgets] = useState<Record<string, string>>({});
  const openJobs = props.allJobs.filter((job) => !jobs.some((held) => held.name === job.name));
  return (
    <article className={`staff-card${agent.active ? "" : " fired"}`}>
      <header className="staff-head">
        <Avatar name={agent.name} seed={agent.nearAccountId} size={48} />
        <div className="staff-who">
          <h3>{agent.name}</h3>
          <span className="mono small muted" title={agent.nearAccountId}>{short(agent.nearAccountId, 18)}</span>
          <span className="chips">{jobs.length ? jobs.map((job) => <span key={job.name} className="chip-role">{job.name}</span>) : <span className="chip-role none">no role</span>}</span>
        </div>
        <StateDot state={props.state} />
      </header>
      <div className="staff-stats">
        <div><strong>{props.executed}</strong><span>done on chain</span></div>
        <div className={props.refused ? "bad" : ""}><strong>{props.refused}</strong><span>refused</span></div>
        <div className="staff-last"><span>Last</span><p>{props.last ?? "No activity yet"}</p></div>
      </div>
      {jobs.flatMap((job) => job.budgets.map((budget) => (
        <div className="staff-budget" key={`${job.name}-${budget.key}`}>
          <BudgetGauge role={job.name} budget={budget} />
          {agent.active ? (
            <div className="row">
              <input aria-label={`New ${budget.label} budget`} inputMode="decimal" placeholder={`new budget (${budget.max ?? ""})`} value={budgets[budget.key] ?? ""} onChange={(event) => setBudgets({ ...budgets, [budget.key]: event.target.value })} />
              <button className="secondary" disabled={!props.canPropose || !(Number(budgets[budget.key]) > 0)} onClick={() => props.onBudget(budget.key, budgets[budget.key]!)}>
                {props.busy === `budget-${agent.id}` ? "Signing…" : "Propose"}
              </button>
            </div>
          ) : null}
        </div>
      )))}
      {agent.active ? <footer className="staff-actions">
        {openJobs.length ? (
          <>
            <select value={hireFor} onChange={(event) => setHireFor(event.target.value)}>
              <option value="">Hire for a role…</option>
              {openJobs.map((job) => <option key={job.name} value={job.name}>{job.name}</option>)}
            </select>
            <button className="secondary" disabled={!props.canPropose || !hireFor} onClick={() => props.onHire(hireFor)}>
              {props.busy === `hire-${agent.id}` ? "Signing…" : "Propose hire"}
            </button>
          </>
        ) : null}
        {!jobs.length ? <Link className="text-action" to={`/roles?new=1&role=${encodeURIComponent(agent.role)}`}>Write a role for it →</Link> : null}
        <div className="spacer" />
        {jobs.length ? (
          <button className="danger" disabled={!props.canPropose} onClick={props.onFire}>
            {props.busy === `fire-${agent.id}` ? "Signing…" : "Propose to fire"}
          </button>
        ) : null}
      </footer> : null}
    </article>
  );
}
