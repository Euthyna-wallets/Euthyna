import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api, type AgentRow } from "../api.js";
import { Card, PageState, Status } from "../components/ui.js";
import { omni } from "../omniroles-api.js";
import { NewAgent, RunYourAgent, type AgentReady } from "./AgentSetup.js";

export function AgentsPage() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status });
  const roles = useQuery({ queryKey: ["omni-roles"], queryFn: omni.roles, enabled: Boolean(status.data?.treasury) });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ agents: AgentRow[] }>("/v1/console/agents"), refetchInterval: 10_000 });
  const [ready, setReady] = useState<AgentReady | null>(null);
  const [adding, setAdding] = useState(false);
  const treasury = status.data?.treasury;
  const rolesOf = (accountId: string) => (roles.data?.roles ?? []).filter((role) => role.members.some((member) => member.member === accountId)).map((role) => role.name);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="muted">
            An agent gets its own NEAR account that can only ask the vault for operations. Its key stays with you; MandateOS only sees the public key.
            It can do nothing until a voted role names it.
          </p>
        </div>
        {treasury && !adding ? <button className="primary" onClick={() => setAdding(true)}>New agent</button> : null}
      </header>
      {!treasury ? <div className="state empty-action">Create the treasury first. <Link className="button primary" to="/onboarding">Continue setup</Link></div> : null}
      {ready && treasury ? <RunYourAgent agent={ready} vaultAccountId={treasury.vaultAccountId} onDone={() => setReady(null)} /> : null}
      {treasury && adding ? (
        <Card title="New agent" action={<button className="ghost" onClick={() => setAdding(false)}>Close</button>}>
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
      <Card title="Agents">
        <PageState loading={agents.isLoading} error={agents.error} empty={agents.data?.agents.length === 0} emptyContent={<div className="state">No agent yet.</div>}>
          <table>
            <thead><tr><th>Name</th><th>NEAR account</th><th>Roles held</th><th>Status</th><th /></tr></thead>
            <tbody>
              {(agents.data?.agents ?? []).map((agent) => {
                const held = rolesOf(agent.nearAccountId);
                return (
                  <tr key={agent.id}>
                    <td>{agent.name}</td>
                    <td className="mono small">{agent.nearAccountId}</td>
                    <td>{held.length ? held.join(", ") : <span className="small muted">none yet · <Link to={`/roles?new=1&role=${encodeURIComponent(agent.role)}`}>give it a role</Link></span>}</td>
                    <td><Status value={agent.active ? "active" : "revoked"} /></td>
                    <td><Link to={`/agents/${agent.id}`}>Details</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </PageState>
      </Card>
    </div>
  );
}
