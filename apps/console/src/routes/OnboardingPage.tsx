import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, type AgentRow } from "../api.js";
import { authClient } from "../auth.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type CouncilMember } from "../omniroles-api.js";
import { NewAgent, RunYourAgent, type AgentReady } from "./AgentSetup.js";
import { FundWallet, TreasuryCreate, WalletSetup } from "./TreasurySetup.js";

type Organization = { id: string; name: string; slug: string };
type Stage = "company" | "members" | "treasury" | "wallet" | "agent" | "role" | "done";

const STEPS: Array<{ id: Exclude<Stage, "done">; label: string }> = [
  { id: "company", label: "Company" },
  { id: "members", label: "Members" },
  { id: "treasury", label: "Treasury" },
  { id: "wallet", label: "Wallet" },
  { id: "agent", label: "Agent" },
  { id: "role", label: "First role" },
];

const confirmedKey = (organizationId: string) => `mandateos.members-confirmed.${organizationId}`;

export function OnboardingPage() {
  const queryClient = useQueryClient();
  const organizations = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => ((await authClient.organization.list()).data ?? []) as Organization[],
  });
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem("mandateos.organization"));
  const active = organizations.data?.find((organization) => organization.id === activeId) ?? organizations.data?.[0] ?? null;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newAgent, setNewAgent] = useState<AgentReady | null>(null);
  const [membersConfirmed, setMembersConfirmed] = useState(false);

  useEffect(() => {
    if (!active) return;
    setReady(false);
    localStorage.setItem("mandateos.organization", active.id);
    setMembersConfirmed(localStorage.getItem(confirmedKey(active.id)) === "1");
    void authClient.organization.setActive({ organizationId: active.id }).finally(() => {
      setReady(true);
      void queryClient.invalidateQueries();
    });
  }, [active?.id]);

  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status, enabled: ready, refetchInterval: 8_000 });
  const members = useQuery({ queryKey: ["omni-members"], queryFn: omni.members, enabled: ready });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ agents: AgentRow[] }>("/v1/console/agents"), enabled: Boolean(status.data?.wallet) });
  const roles = useQuery({ queryKey: ["omni-roles"], queryFn: omni.roles, enabled: Boolean(status.data?.treasury), refetchInterval: 15_000 });

  const treasury = status.data?.treasury ?? null;
  const memberCount = members.data?.members.filter((member) => member.nearAccountId).length ?? 0;
  const activeAgents = (agents.data?.agents ?? []).filter((agent) => agent.active);
  const stage: Stage = !active
    ? "company"
    : !treasury
      ? (memberCount < 3 || !membersConfirmed ? "members" : "treasury")
      : !status.data?.wallet
        ? "wallet"
        : newAgent || activeAgents.length === 0
          ? "agent"
          : (roles.data?.roles.length ?? 0) === 0
            ? "role"
            : "done";
  const loading = organizations.isLoading || (Boolean(active) && (!ready || status.isLoading || members.isLoading));

  const waitingFor: Record<Stage, string> = {
    company: "Name the company",
    members: `${memberCount} of 3 members · add the NEAR accounts that will vote`,
    treasury: "Create the DAO and the vault",
    wallet: "Members vote to create the company wallet",
    agent: "Fund the wallet and create the agent",
    role: "Say what the agent may do",
    done: "Setup complete",
  };

  return (
    <div className="page onboarding-page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Company setup</span>
          <h1>{active?.name ?? "Create your company"}</h1>
          <p className="muted">Humans set the rules once. Agents then work inside them, and nothing else gets signed.</p>
          {!loading ? <p className="setup-actor">{waitingFor[stage]}</p> : null}
        </div>
        <div className="pill">Base Sepolia · NEAR testnet</div>
      </header>
      {error ? <div className="alert error">{error}</div> : null}
      {loading ? <div className="state">Loading…</div> : (
        <>
          <SetupProgress stage={stage} />

          {stage === "company" ? (
            <CompanyStep
              organizations={organizations.data ?? []}
              onCreated={async (organization) => {
                setActiveId(organization.id);
                await organizations.refetch();
              }}
              onError={setError}
            />
          ) : null}

          {stage === "members" && members.data ? (
            <MembersStep
              members={members.data.members}
              onChanged={async () => { await members.refetch(); }}
              onContinue={() => {
                if (active) localStorage.setItem(confirmedKey(active.id), "1");
                setMembersConfirmed(true);
              }}
              onError={setError}
            />
          ) : null}

          {stage === "treasury" && active ? (
            <>
              <TreasuryCreate companyName={active.name} onCreated={async () => { await status.refetch(); }} />
              <button className="ghost" onClick={() => setMembersConfirmed(false)}>← Change members</button>
            </>
          ) : null}

          {stage === "wallet" && status.data ? <WalletSetup status={status.data} onChanged={async () => { await status.refetch(); }} /> : null}

          {(stage === "agent" || stage === "role") && status.data ? <FundWallet status={status.data} showNext={false} /> : null}

          {stage === "agent" && treasury ? (
            newAgent ? (
              <RunYourAgent
                agent={newAgent}
                vaultAccountId={treasury.vaultAccountId}
                onDone={() => {
                  setNewAgent(null);
                  void agents.refetch();
                }}
              />
            ) : (
              <section className="card">
                <h2>Create the agent</h2>
                <p className="muted">
                  The agent gets its own NEAR account. It can only ask the vault for operations, and only those a voted role allows.
                </p>
                <NewAgent vaultAccountId={treasury.vaultAccountId} onReady={setNewAgent} />
              </section>
            )
          ) : null}

          {stage === "role" ? (
            <section className="card empty-action">
              <div>
                <h2>Create the first role</h2>
                <p className="muted">
                  Pick what {activeAgents[0]?.name ?? "the agent"} may do: transfers to registered suppliers, or DeFi from the catalog (Uniswap), each with a budget.
                  Members vote, and it applies after the veto window.
                </p>
              </div>
              <Link className="button primary" to={`/roles?new=1&role=${encodeURIComponent(activeAgents[0]?.role ?? "treasury")}`}>Build the role</Link>
            </section>
          ) : null}

          {stage === "done" ? (
            <section className="card empty-action">
              <div>
                <h2>Setup complete</h2>
                <p className="muted">The treasury, the wallet, an agent and its first role are in place.</p>
              </div>
              <Link className="button primary" to="/">Go to Overview</Link>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function SetupProgress({ stage }: { stage: Stage }) {
  const current = stage === "done" ? STEPS.length : STEPS.findIndex((step) => step.id === stage);
  return (
    <nav className="setup-progress" aria-label="Company setup progress">
      {STEPS.map((step, index) => (
        <div key={step.id} className={`${index < current ? "done" : ""} ${index === current ? "current" : ""}`}>
          <span>{index < current ? "✓" : index + 1}</span>
          {step.label}
        </div>
      ))}
    </nav>
  );
}

function CompanyStep(props: { organizations: Organization[]; onCreated: (organization: Organization) => Promise<void>; onError: (message: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const created = await authClient.organization.create({ name: name.trim(), slug });
      if (created.error || !created.data) throw new Error(created.error?.message ?? "Could not create the company");
      await props.onCreated(created.data as Organization);
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>Create your company</h2>
      <p className="muted">The name is also used for the DAO and vault accounts on NEAR.</p>
      <div className="row">
        <input placeholder="Company name" value={name} onChange={(event) => setName(event.target.value)} />
        <button className="primary" disabled={busy || name.trim().length < 2} onClick={() => void create()}>Create company</button>
      </div>
    </section>
  );
}

function MembersStep(props: {
  members: CouncilMember[];
  onChanged: () => Promise<void>;
  onContinue: () => void;
  onError: (message: string) => void;
}) {
  const wallets = useWallets();
  const [account, setAccount] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const count = props.members.filter((member) => member.nearAccountId).length;
  const threshold = Math.ceil((2 * Math.max(count, 3)) / 3);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    props.onError("");
    try {
      await action();
      await props.onChanged();
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Who votes on the rules?</h2>
      <p className="muted">
        Add the NEAR accounts of the people who will vote. No invitation is sent: each person signs in here with that wallet.
        Like the owners of a Safe, they become the DAO members when the treasury is created.
      </p>
      <table>
        <thead><tr><th>NEAR account</th><th>Name</th><th>Signed in</th><th /></tr></thead>
        <tbody>
          {props.members.map((member) => (
            <tr key={member.id}>
              <td className="mono">{member.nearAccountId ?? <span className="muted">—</span>}{member.nearAccountId === wallets.nearAccountId ? <span className="small muted"> (you)</span> : null}</td>
              <td>{member.name ?? <span className="muted">—</span>}</td>
              <td className="small">{member.signedIn ? "yes" : <span className="muted">not yet</span>}</td>
              <td>
                {member.role !== "owner" ? (
                  <button className="ghost" disabled={busy} onClick={() => void run(() => omni.removeMember(member.id))}>Remove</button>
                ) : <span className="small muted">founder</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="row wrap"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await omni.addMember({ nearAccountId: account.trim().toLowerCase(), ...(name.trim() ? { name: name.trim() } : {}) });
            setAccount("");
            setName("");
          });
        }}
      >
        <label>NEAR account<input placeholder="bob.testnet" value={account} onChange={(event) => setAccount(event.target.value)} /></label>
        <label>Name (optional)<input placeholder="Bob" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <button className="secondary" type="submit" disabled={busy || account.trim().length < 2}>{busy ? "Checking on NEAR…" : "Add member"}</button>
      </form>
      <p className="small muted">
        The account must exist on NEAR testnet. Each member needs about 0.3 NEAR to pay for votes.
      </p>
      <div className="row">
        <span className="small">
          {count < 3 ? `Add at least ${3 - count} more member${3 - count > 1 ? "s" : ""}.` : `${count} members · a decision will need ${threshold} of ${count} approvals.`}
        </span>
        <div className="spacer" />
        <button className="primary" disabled={count < 3} onClick={props.onContinue}>Continue</button>
      </div>
    </section>
  );
}
