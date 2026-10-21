import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { api, type AgentRow } from "../api.js";
import { Card, PageState, Status, short } from "../components/ui.js";

interface Detail {
  agent: AgentRow;
  treasury: { vaultAccountId: string; daoAccountId: string } | null;
  onChain: Record<string, unknown> | null;
  mandate: Record<string, unknown> | null;
  ethBalance: string | null;
  audit: Array<{ id: string; action: string; actorId: string; createdAt: string }>;
}

export function AgentDetailPage() {
  const { id = "" } = useParams();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["agent", id], queryFn: () => api<Detail>(`/v1/console/agents/${id}/detail`), refetchInterval: 10_000 });
  const revoke = useMutation({
    mutationFn: () => api(`/v1/console/agents/${id}/revoke`, { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["agent", id] }),
  });
  const pause = useMutation({
    mutationFn: () => api(`/v1/console/agents/${id}/pause-proposal`, { method: "POST" }),
  });
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>{query.data?.agent.name ?? "Agent"}</h1><p className="muted"><Link to="/agents">← Agents</Link></p></div>
      </header>
      <PageState loading={query.isLoading} error={query.error} empty={!query.data}>
        {query.data ? (
          <>
            <div className="metrics">
              <div className="metric"><span>Status</span><strong>{query.data.agent.active ? "Active" : "Revoked"}</strong></div>
              <div className="metric"><span>0xAAA</span><strong className="mono small">{short(query.data.agent.evmAddress)}</strong></div>
              <div className="metric"><span>Gas ETH</span><strong>{query.data.ethBalance ? `${(Number(query.data.ethBalance) / 1e18).toFixed(5)} ETH` : "—"}</strong></div>
              <div className="metric"><span>Nonce</span><strong>{String((query.data.onChain as { evm_nonce?: unknown })?.evm_nonce ?? "—")}</strong></div>
            </div>
            <Card title="On-chain state">
              <pre>{JSON.stringify(query.data.onChain ?? { status: "unavailable" }, null, 2)}</pre>
            </Card>
            <Card title="Current mandate">
              {query.data.mandate ? <pre>{JSON.stringify(query.data.mandate, null, 2)}</pre> : <div className="state">No mandate.</div>}
            </Card>
            <Card title="Actions" action={<Status value={query.data.agent.active ? "active" : "revoked"} />}>
              <div className="row wrap">
                <button className="ghost" onClick={() => revoke.mutate()} disabled={!query.data.agent.active || revoke.isPending}>Revoke agent</button>
                <button className="ghost" onClick={() => pause.mutate()} disabled={pause.isPending}>Prepare pause proposal</button>
              </div>
              {pause.data ? <pre>{JSON.stringify(pause.data, null, 2)}</pre> : null}
            </Card>
            <Card title="Audit">
              {query.data.audit.length === 0 ? <div className="state">No audit rows.</div> : (
                <table><thead><tr><th>Action</th><th>Actor</th><th>Date</th></tr></thead><tbody>
                  {query.data.audit.map((row) => <tr key={row.id}><td>{row.action}</td><td className="mono small">{short(row.actorId)}</td><td>{new Date(row.createdAt).toLocaleString()}</td></tr>)}
                </tbody></table>
              )}
            </Card>
          </>
        ) : null}
      </PageState>
    </div>
  );
}
