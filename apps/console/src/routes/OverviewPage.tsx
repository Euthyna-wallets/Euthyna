import { useQuery } from "@tanstack/react-query";

import { api, explorerBase, explorerNear, type OperationRow, type TreasuryView } from "../api.js";
import { Card, PageState, Status, short } from "../components/ui.js";
import { formatToken } from "../lib/format.js";

interface Overview {
  treasury: TreasuryView | null;
  registryVersion: number;
  agents: { total: number; active: number };
  pendingEscalations: number;
  safeBalance: string | null;
  roleBudgets: Array<{ role: string; funded?: string; reserved?: string; spent?: string; available?: string }>;
  operations: OperationRow[];
}

export function OverviewPage() {
  const query = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/v1/console/overview"), refetchInterval: 10_000 });
  return (
    <div className="page">
      <header className="page-head"><div><h1>Overview</h1><p className="muted">Treasury, mandates and recent activity.</p></div></header>
      <PageState loading={query.isLoading} error={query.error} empty={!query.data}>
        {query.data ? (
          <>
            <div className="metrics">
              <div className="metric"><span>Safe TestUSDC</span><strong>{query.data.safeBalance ?? "—"}</strong></div>
              <div className="metric"><span>Active agents</span><strong>{query.data.agents.active}/{query.data.agents.total}</strong></div>
              <div className="metric"><span>Pending escalations</span><strong>{query.data.pendingEscalations}</strong></div>
              <div className="metric"><span>Registry version</span><strong>{query.data.registryVersion}</strong></div>
            </div>
            <Card title="Treasury">
              {query.data.treasury ? (
                <table>
                  <tbody>
                    <tr><td>DAO</td><td><a href={explorerNear(query.data.treasury.daoAccountId)} target="_blank" rel="noreferrer">{query.data.treasury.daoAccountId}</a></td></tr>
                    <tr><td>Vault</td><td><a href={explorerNear(query.data.treasury.vaultAccountId)} target="_blank" rel="noreferrer">{query.data.treasury.vaultAccountId}</a></td></tr>
                    <tr><td>Safe</td><td><a href={explorerBase(query.data.treasury.safeAddress)} target="_blank" rel="noreferrer">{query.data.treasury.safeAddress}</a></td></tr>
                    <tr><td>Delay</td><td><a href={explorerBase(query.data.treasury.delayAddress)} target="_blank" rel="noreferrer">{query.data.treasury.delayAddress}</a></td></tr>
                    <tr><td>Status</td><td><Status value={query.data.treasury.status} /></td></tr>
                  </tbody>
                </table>
              ) : <div className="state">No treasury yet. Run onboarding.</div>}
            </Card>
            <Card title="Role budgets">
              {query.data.roleBudgets.length === 0 ? <div className="state">No role deployed yet.</div> : (
                <table>
                  <thead><tr><th>Role</th><th>Funded</th><th>Reserved</th><th>Spent</th><th>Available</th></tr></thead>
                  <tbody>
                    {query.data.roleBudgets.map((budget) => (
                      <tr key={budget.role}>
                        <td>{budget.role}</td>
                        <td className="mono">{formatToken(budget.funded)}</td>
                        <td className="mono">{formatToken(budget.reserved)}</td>
                        <td className="mono">{formatToken(budget.spent)}</td>
                        <td className="mono">{formatToken(budget.available)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Recent operations">
              {query.data.operations.length === 0 ? <div className="state">No operations yet.</div> : (
                <table>
                  <thead><tr><th>Reference</th><th>Amount</th><th>Status</th><th>Op</th></tr></thead>
                  <tbody>
                    {query.data.operations.map((operation) => (
                      <tr key={operation.opId}>
                        <td>{operation.reference}</td>
                        <td className="mono">{formatToken(operation.amount)}</td>
                        <td><Status value={operation.state} /></td>
                        <td className="mono small">{short(operation.opId)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        ) : null}
      </PageState>
    </div>
  );
}
