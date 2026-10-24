import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { api, type AgentRow } from "../api.js";
import { Card, PageState, Status, short } from "../components/ui.js";

export function AgentsPage() {
  const query = useQuery({ queryKey: ["agents"], queryFn: () => api<{ agents: AgentRow[] }>("/v1/console/agents"), refetchInterval: 10_000 });
  return (
    <div className="page">
      <header className="page-head"><div><h1>Agents</h1><p className="muted">AI identities, spending permissions and account state.</p></div></header>
      <Card title="Agents">
        <PageState loading={query.isLoading} error={query.error} empty={query.data?.agents.length === 0} emptyContent={<div className="state empty-action">No agent yet. <Link className="button primary" to="/onboarding">Register an agent</Link></div>}>
          <table>
            <thead><tr><th>Name</th><th>Role</th><th>NEAR account</th><th>Base account</th><th>Status</th><th /></tr></thead>
            <tbody>
              {(query.data?.agents ?? []).map((agent) => (
                <tr key={agent.id}>
                  <td>{agent.name}</td>
                  <td>{agent.role}</td>
                  <td className="mono small">{agent.nearAccountId}</td>
                  <td className="mono small">{short(agent.evmAddress)}</td>
                  <td><Status value={agent.active ? "active" : "revoked"} /></td>
                  <td><Link to={`/agents/${agent.id}`}>Details</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </PageState>
      </Card>
    </div>
  );
}
