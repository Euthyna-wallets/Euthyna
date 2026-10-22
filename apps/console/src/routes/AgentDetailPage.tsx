import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { api, type AgentRow } from "../api.js";
import { SecondaryButton } from "../components/SecondaryButton.js";
import { Card, PageState, Status, short } from "../components/ui.js";
import { formatBytesAddress, formatEth, formatNonce, formatToken } from "../lib/format.js";

interface Detail {
  agent: AgentRow;
  treasury: { vaultAccountId: string; daoAccountId: string } | null;
  provisioning: { status: string; confirmedAt: string | null } | null;
  onChain: Record<string, unknown> | null;
  mandate: Record<string, unknown> | null;
  budget: { config?: Record<string, unknown>; funded?: string; reserved?: string; spent?: string; available?: string } | null;
  nonce: number | null;
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
              <div className="metric"><span>Gas ETH</span><strong>{formatEth(query.data.ethBalance)}</strong></div>
              <div className="metric"><span>Nonce</span><strong>{formatNonce(query.data.nonce)}</strong></div>
            </div>
            {!query.data.onChain ? (
              <div className="alert error">
                Agent is not registered in the Vault. Execute set_role, then register_agent before starting the SDK.
              </div>
            ) : !(query.data.onChain as { evm_address?: unknown }).evm_address ? (
              <div className="alert">
                0xAAA is not derived. Start the SDK with this agent key; it will call request_derived_public_key once before prepare.
              </div>
            ) : null}
            <Card title="On-chain state">
              <table>
                <tbody>
                  <tr><td>Active</td><td><Status value={(query.data.onChain as { active?: unknown })?.active === true ? "active" : "revoked"} /></td></tr>
                  <tr><td>Role</td><td>{String((query.data.onChain as { role?: unknown })?.role ?? "—")}</td></tr>
                  <tr><td>0xAAA</td><td className="mono">{formatBytesAddress((query.data.onChain as { evm_address?: unknown })?.evm_address ?? query.data.agent.evmAddress)}</td></tr>
                  <tr><td>Provisioning</td><td><Status value={query.data.provisioning?.status ?? "not started"} /></td></tr>
                  <tr><td>MPC path</td><td className="mono">{String((query.data.onChain as { mpc_path?: unknown })?.mpc_path ?? query.data.agent.mpcPath)}</td></tr>
                  <tr><td>Nonce</td><td>{formatNonce(query.data.nonce)}</td></tr>
                  <tr><td>Budget funded</td><td className="mono">{formatToken(query.data.budget?.funded)}</td></tr>
                  <tr><td>Budget reserved</td><td className="mono">{formatToken(query.data.budget?.reserved)}</td></tr>
                  <tr><td>Budget spent</td><td className="mono">{formatToken(query.data.budget?.spent)}</td></tr>
                </tbody>
              </table>
            </Card>
            <Card title="Current mandate">
              {query.data.mandate ? (
                <table>
                  <tbody>
                    <tr><td>Role</td><td>{String((query.data.mandate as { config?: { enabled?: boolean } }).config?.enabled === false ? "disabled" : query.data.agent.role)}</td></tr>
                    <tr><td>Max per tx</td><td className="mono">{formatToken(String((query.data.mandate as { config?: { max_per_tx?: string } }).config?.max_per_tx ?? "0"))}</td></tr>
                    <tr><td>Funded</td><td className="mono">{formatToken(query.data.budget?.funded)}</td></tr>
                    <tr><td>Reserved</td><td className="mono">{formatToken(query.data.budget?.reserved)}</td></tr>
                    <tr><td>Spent</td><td className="mono">{formatToken(query.data.budget?.spent)}</td></tr>
                  </tbody>
                </table>
              ) : <div className="state">No mandate.</div>}
            </Card>
            <Card title="Mandate" action={<Link to="/mandate">Open mandate</Link>}>
              <p className="muted small">Preview the role diff and prepare the proposals.</p>
            </Card>
            <Card title="Actions" action={<Status value={query.data.agent.active ? "active" : "revoked"} />}>
              <div className="row wrap">
                <SecondaryButton onClick={() => revoke.mutate()} disabled={!query.data.agent.active || revoke.isPending}>Revoke agent</SecondaryButton>
                <SecondaryButton onClick={() => pause.mutate()} disabled={pause.isPending}>Prepare pause proposal</SecondaryButton>
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
