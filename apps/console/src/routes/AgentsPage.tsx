import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { decodeVaultCalls } from "@mandateos/sdk/roles";

import { api, type AgentRow } from "../api.js";
import { Kicker, Niche, NightPanel, PageTitle, SectionHead, Slab } from "../components/design.js";
import { agentState, ago, feedOf, type AgentState } from "../components/ops.js";
import { PageState, everyDays, short } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type ProposalDraft, type RoleView } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";
import { NewAgent, RunYourAgent, type AgentReady } from "./AgentSetup.js";

const CHIP: CSSProperties = { font: "700 10px var(--font-brand)", letterSpacing: ".14em", padding: "3px 8px", background: "#FCF0D4", color: "#8A5A00", border: "1px solid rgba(201,137,12,.35)" };
const CHIP_NONE: CSSProperties = { ...CHIP, background: "rgba(13,23,48,.06)", color: "#66718C", borderColor: "rgba(13,23,48,.18)" };
const STAT: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, padding: "10px 0" };
const STAT_NUMBER: CSSProperties = { font: "600 20px var(--font-mono)" };
const STAT_LABEL: CSSProperties = { fontSize: 11.5, color: "#66718C" };
const INPUT: CSSProperties = { flex: 1, minWidth: 0, padding: "7px 10px", border: "1px solid rgba(13,23,48,.2)", background: "rgba(255,255,255,.7)", font: "12px var(--font-mono)", color: "#0D1730" };
const MINI: CSSProperties = { padding: "7px 10px", font: "700 10.5px var(--font-brand)", letterSpacing: ".14em", border: "1px solid rgba(13,23,48,.25)", color: "#0D1730", background: "rgba(255,255,255,.6)", cursor: "pointer" };
const HIRE_STEPS: Array<[string, string]> = [
  ["I", "A council member hires: the agent gets its own NEAR account."],
  ["II", "The owners vote its role and budget. Until then it can do nothing."],
  ["III", "It asks the vault for each operation; firing it is one more vote."],
];

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
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ font: "600 12px var(--font-ui)", color: "#66718C" }}>Staff</span>
          <PageTitle>AGENTS</PageTitle>
          <span style={{ fontSize: 14, color: "#4A5675", maxWidth: 760 }}>
            Agents work inside the roles the owners voted. Their record is read from the chains: what they did, what the vault
            or the Guard refused. Any council member can hire (up to 5 agents waiting for a role each); the owners give roles, change budgets and fire, by vote.
          </span>
        </div>
        {treasury && !adding ? (
          <button className="btn-ori" style={{ marginLeft: "auto", whiteSpace: "nowrap" }} onClick={() => setAdding(true)}>
            HIRE AN AGENT
          </button>
        ) : null}
      </header>
      {error ? (
        <div style={{ border: "1px solid rgba(217,87,59,.55)", background: "#FBE3D6", color: "var(--terra-ink)", padding: "12px 16px", fontSize: 14 }}>
          {error}
        </div>
      ) : null}
      {notice ? (
        <div style={{ border: "1px solid rgba(79,209,232,.5)", background: "var(--aegean-bg)", color: "var(--aegean-ink)", padding: "12px 16px", fontSize: 14 }}>
          {notice}
        </div>
      ) : null}
      {status.data && !treasury ? (
        <Slab style={{ padding: "18px 22px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, color: "#4A5675" }}>Create the company first.</span>
          <Link to="/onboarding" className="btn-ori" style={{ marginLeft: "auto", textDecoration: "none" }}>
            CONTINUE SETUP
          </Link>
        </Slab>
      ) : null}
      {ready && treasury ? <RunYourAgent agent={ready} vaultAccountId={treasury.vaultAccountId} onDone={() => setReady(null)} /> : null}
      {treasury && adding ? (
        <Slab style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
          <SectionHead
            left={<Kicker>Hire an agent</Kicker>}
            right={<button className="btn-line" style={{ padding: "8px 14px" }} onClick={() => setAdding(false)}>CLOSE</button>}
          />
          <NewAgent
            vaultAccountId={treasury.vaultAccountId}
            onReady={(agent) => {
              setReady(agent);
              setAdding(false);
              void queryClient.invalidateQueries({ queryKey: ["agents"] });
            }}
          />
        </Slab>
      ) : null}
      <PageState
        loading={agents.isLoading}
        error={agents.error}
        empty={agents.data?.agents.length === 0}
        emptyContent={
          <Slab style={{ padding: "20px 22px" }}>
            <p className="empty-state" style={{ margin: 0 }}>No agent yet.</p>
          </Slab>
        }
      >
        {(() => {
          const cards = (agents.data?.agents ?? []).slice().sort((a, b) => Number(b.active) - Number(a.active)).map((agent) => {
            const jobs = (roles.data?.roles ?? []).filter((role) => role.members.some((member) => member.member === agent.nearAccountId));
            const isAgent = (actor: string) => actor === agent.name || actor === agent.nearAccountId;
            const done = (activity.data?.operations ?? []).filter((operation) => isAgent(operation.actor));
            const executed = done.filter((operation) => operation.evm?.status === "success");
            const refused = (activity.data?.requests ?? []).filter((request) => request.kind === "refusal" && isAgent(request.agent));
            const feed = feedOf(activity.data);
            const lastItem = feed.find((item) => isAgent(item.actor));
            return {
              hasRole: jobs.length > 0,
              active: agent.active,
              node: (
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
              ),
            };
          });
          const staffCards = cards.filter((card) => card.hasRole || !card.active).map((card) => card.node);
          const waitingCards = cards.filter((card) => !card.hasRole && card.active).map((card) => card.node);
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {staffCards.length ? (
                <div className="g3" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 18, alignItems: "stretch" }}>
                  {staffCards}
                </div>
              ) : null}
              <div
                className="g2"
                style={{ display: "grid", gridTemplateColumns: waitingCards.length ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)", gap: 18, alignItems: "start" }}
              >
                {waitingCards}
                <NightPanel style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 10, maxWidth: 640 }}>
                  <Kicker color="var(--gold)">How hiring works</Kicker>
                  {HIRE_STEPS.map(([numeral, text]) => (
                    <div key={numeral} style={{ display: "grid", gridTemplateColumns: "34px minmax(0, 1fr)", gap: 10, alignItems: "center", fontSize: 13.5, color: "var(--night-soft)" }}>
                      <span className="app-seal" style={{ width: 30, height: 30 }} aria-hidden="true">
                        <span style={{ fontSize: numeral.length > 2 ? 10 : 11, letterSpacing: ".08em" }}>{numeral}</span>
                      </span>
                      <span>{text}</span>
                    </div>
                  ))}
                </NightPanel>
              </div>
            </div>
          );
        })()}
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
  const stateColor = props.state === "working"
    ? "var(--aegean-ink)"
    : props.state === "no role"
      ? "var(--gold-ink)"
      : props.state === "idle"
        ? "#66718C"
        : "var(--terra-ink)";
  const nicheState = props.state === "paused" || props.state === "fired" ? "paused" : props.state === "working" ? "working" : "idle";
  return (
    <Slab as="article" style={{ display: "flex", flexDirection: "column", opacity: agent.active ? 1 : 0.72 }}>
      <header style={{ display: "grid", gridTemplateColumns: "84px minmax(0, 1fr)", gap: 14, padding: "16px 18px 6px" }}>
        <Niche role={jobs[0]?.name ?? agent.role} state={nicheState} height={112} width={84} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <b style={{ font: "800 19px var(--font-brand)", letterSpacing: ".1em" }}>{agent.name.toUpperCase()}</b>
            <span style={{ fontSize: 12, fontWeight: 700, color: stateColor }}>
              ● {props.state === "no role" ? "waiting for a role" : props.state}
            </span>
          </div>
          <span
            className="mono"
            title={agent.nearAccountId}
            style={{ fontSize: 11.5, color: "#66718C", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}
          >
            {short(agent.nearAccountId, 18)}
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {jobs.length
              ? jobs.map((job) => <span key={job.name} style={CHIP}>{job.name.toUpperCase()}</span>)
              : <span style={CHIP_NONE}>NO ROLE</span>}
          </div>
        </div>
      </header>
      <div style={{ display: "grid", gridTemplateColumns: "70px 70px minmax(0, 1fr)", gap: 12, padding: "0 18px", borderTop: "1px solid rgba(13,23,48,.1)", marginTop: 8 }}>
        <div style={STAT}><b style={STAT_NUMBER}>{props.executed}</b><span style={STAT_LABEL}>done on chain</span></div>
        <div style={STAT}><b style={{ ...STAT_NUMBER, color: props.refused ? "var(--terra-ink)" : "#0D1730" }}>{props.refused}</b><span style={STAT_LABEL}>refused</span></div>
        <div style={{ ...STAT, minWidth: 0 }}><span style={STAT_LABEL}>Last</span><span style={{ fontSize: 12.5, color: "#0D1730", fontWeight: 600 }}>{props.last ?? "No activity yet"}</span></div>
      </div>
      {jobs.flatMap((job) => job.budgets.map((budget) => {
        const available = Number(budget.available ?? 0);
        const max = Number(budget.max ?? 0);
        const left = max > 0 ? Math.max(0, Math.min(100, Math.round((available / max) * 100))) : 0;
        return (
          <div key={`${job.name}-${budget.key}`} style={{ padding: "0 18px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 0", borderTop: "1px solid rgba(13,23,48,.1)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, color: "#4A5675" }}>
                <span>{job.name !== budget.label ? `${job.name} · ` : ""}{budget.label}{budget.periodDays ? ` · ${everyDays(budget.periodDays)}` : ""}</span>
                <b style={{ font: "600 12px var(--font-mono)", color: "#0D1730" }}>
                  {available.toLocaleString()} / {max.toLocaleString()}{budget.token ? ` ${budget.token}` : ""}
                </b>
              </div>
              <div className="groove" role="img" aria-label={`${left}% of the budget left`}><i style={{ width: `${left}%` }} /></div>
              {agent.active ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    aria-label={`New ${budget.label} budget`}
                    inputMode="decimal"
                    placeholder={`new budget (${budget.max ?? ""})`}
                    value={budgets[budget.key] ?? ""}
                    onChange={(event) => setBudgets({ ...budgets, [budget.key]: event.target.value })}
                    style={INPUT}
                  />
                  <button
                    style={MINI}
                    disabled={!props.canPropose || !(Number(budgets[budget.key]) > 0)}
                    onClick={() => props.onBudget(budget.key, budgets[budget.key]!)}
                  >
                    {props.busy === `budget-${agent.id}` ? "Signing…" : "PROPOSE"}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        );
      }))}
      {agent.active ? (
        <footer style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 10, padding: "12px 18px 16px", borderTop: "1px solid rgba(13,23,48,.1)" }}>
          {openJobs.length ? (
            <div style={{ display: "flex", gap: 6 }}>
              <select
                value={hireFor}
                onChange={(event) => setHireFor(event.target.value)}
                style={{ ...INPUT, font: "12px var(--font-ui)", color: "#4A5675" }}
              >
                <option value="">Give it another role…</option>
                {openJobs.map((job) => <option key={job.name} value={job.name}>{job.name}</option>)}
              </select>
              <button style={MINI} disabled={!props.canPropose || !hireFor} onClick={() => props.onHire(hireFor)}>
                {props.busy === `hire-${agent.id}` ? "Signing…" : "PROPOSE HIRE"}
              </button>
            </div>
          ) : null}
          {!jobs.length ? (
            <Link
              to={`/roles?new=1&role=${encodeURIComponent(agent.role)}`}
              style={{ alignSelf: "flex-start", font: "700 10.5px var(--font-brand)", letterSpacing: ".16em", color: "var(--gold-ink)", textDecoration: "none" }}
            >
              WRITE A ROLE FOR IT →
            </Link>
          ) : null}
          {jobs.length ? (
            <button className="btn-danger" style={{ alignSelf: "flex-end", textTransform: "uppercase" }} disabled={!props.canPropose} onClick={props.onFire}>
              {props.busy === `fire-${agent.id}` ? "Signing…" : "Fire by vote"}
            </button>
          ) : null}
        </footer>
      ) : null}
    </Slab>
  );
}
