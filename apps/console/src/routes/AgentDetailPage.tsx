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
  nearGasBalanceYocto: string | null;
  nearGasLow: boolean;
  nearGasLowThresholdYocto: string;
  audit: Array<{ id: string; action: string; actorId: string; createdAt: string }>;
}

function mandateField(mandate: Record<string, unknown> | null, field: string): unknown {
  const config = mandate?.config;
  if (!config || typeof config !== "object" || !(field in config)) return undefined;
  return Reflect.get(config, field);
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
              <div className="metric"><span>Base account</span><strong className="mono small">{short(query.data.agent.evmAddress)}</strong></div>
              <div className="metric"><span>Base gas</span><strong>{formatEth(query.data.ethBalance)}</strong></div>
              <div className="metric"><span>NEAR gas</span><strong>{formatToken(query.data.nearGasBalanceYocto, 24, "NEAR", 4)}</strong></div>
            </div>
            {query.data.nearGasLow ? (
              <div className="alert error">
                Agent gas balance is below {formatToken(query.data.nearGasLowThresholdYocto, 24, "NEAR", 4)}.
                Recharge it with a simple NEAR transfer to <span className="mono">{query.data.agent.nearAccountId}</span>.
                Do not add or replace its restricted key.
              </div>
            ) : null}
            {!query.data.onChain ? (
              <div className="alert error">
                This agent is not registered for spending. Finish its spending permission before starting the agent.
              </div>
            ) : !query.data.onChain.evm_address ? (
              <div className="alert">
                The Base account is pending. Start the agent once to create it before the first payment.
              </div>
            ) : null}
            <Card title="Advanced">
              <details>
                <summary>On-chain agent state</summary>
                <table>
                  <tbody>
                    <tr><td>Active</td><td><Status value={query.data.onChain?.active === true ? "active" : "revoked"} /></td></tr>
                    <tr><td>Role</td><td>{String(query.data.onChain?.role ?? "—")}</td></tr>
                    <tr><td>Base account</td><td className="mono">{formatBytesAddress(query.data.onChain?.evm_address ?? query.data.agent.evmAddress)}</td></tr>
                    <tr><td>Provisioning</td><td><Status value={query.data.provisioning?.status ?? "not started"} /></td></tr>
                    <tr><td>MPC path</td><td className="mono">{String(query.data.onChain?.mpc_path ?? query.data.agent.mpcPath)}</td></tr>
                    <tr><td>Nonce</td><td>{formatNonce(query.data.nonce)}</td></tr>
                    <tr><td>Budget funded</td><td className="mono">{formatToken(query.data.budget?.funded)}</td></tr>
                    <tr><td>Budget reserved</td><td className="mono">{formatToken(query.data.budget?.reserved)}</td></tr>
                    <tr><td>Budget spent</td><td className="mono">{formatToken(query.data.budget?.spent)}</td></tr>
                  </tbody>
                </table>
              </details>
            </Card>
            <Card title="Current spending permission">
              {query.data.mandate ? (
                <table>
                  <tbody>
                    <tr><td>Role</td><td>{String(mandateField(query.data.mandate, "enabled") === false ? "disabled" : query.data.agent.role)}</td></tr>
                    <tr><td>Max per tx</td><td className="mono">{formatToken(String(mandateField(query.data.mandate, "max_per_tx") ?? "0"))}</td></tr>
                    <tr><td>Funded</td><td className="mono">{formatToken(query.data.budget?.funded)}</td></tr>
                    <tr><td>Reserved</td><td className="mono">{formatToken(query.data.budget?.reserved)}</td></tr>
                    <tr><td>Spent</td><td className="mono">{formatToken(query.data.budget?.spent)}</td></tr>
                  </tbody>
                </table>
              ) : <div className="state">No spending permission.</div>}
            </Card>
            <Card title="Spending permission" action={<Link to="/mandate">Open settings</Link>}>
              <p className="muted small">Preview the role changes and prepare council decisions.</p>
            </Card>
            <Card title="Actions" action={<Status value={query.data.agent.active ? "active" : "revoked"} />}>
              <div className="row wrap">
                <SecondaryButton onClick={() => revoke.mutate()} disabled={!query.data.agent.active || revoke.isPending} title={!query.data.agent.active ? "This agent is already revoked" : revoke.isPending ? "Revocation is in progress" : "Revoke this agent credential"}>Revoke agent</SecondaryButton>
                <SecondaryButton onClick={() => pause.mutate()} disabled={pause.isPending} title={pause.isPending ? "A pause decision is being prepared" : "Prepare a council decision to pause this agent"}>Prepare pause proposal</SecondaryButton>
              </div>
              {pause.data ? <details><summary>Advanced proposal</summary><pre>{JSON.stringify(pause.data, null, 2)}</pre></details> : null}
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
