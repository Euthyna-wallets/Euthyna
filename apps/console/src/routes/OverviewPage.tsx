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
interface OverviewMember {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
  walletProofVerifiedAt: string | null;
  walletProofApprovedAt: string | null;
}


export function OverviewPage() {
  const query = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/v1/console/overview"), refetchInterval: 10_000 });
  const members = useQuery({
    queryKey: ["members", "overview"],
    queryFn: () => api<{ members: OverviewMember[] }>("/v1/console/members"),
    refetchInterval: 10_000,
  });
  const nextStep = !query.data?.treasury
    ? { title: "Create your Treasury", detail: "Continue the guided setup with your council.", action: "Finish setup", href: "/onboarding" }
    : query.data.agents.total === 0
      ? { title: "Register your AI agent", detail: "Create its account and one-time API key.", action: "Finish setup", href: "/onboarding" }
      : query.data.roleBudgets.length === 0
        ? { title: "Create a spending permission", detail: "Choose its USDC budget and approved suppliers.", action: "Finish setup", href: "/onboarding" }
        : query.data.operations.length === 0
          ? { title: "Pay the first invoice", detail: "Connect the agent to the MCP or SDK.", action: "Open agents", href: "/agents" }
          : { title: "Review recent activity", detail: "Check completed payments and escalations.", action: "View operations", href: "/operations" };
  return (
    <div className="page">
      <header className="page-head"><div><h1>Overview</h1><p className="muted">Treasury, spending permissions and recent activity.</p></div></header>
      <PageState loading={query.isLoading} error={query.error} empty={!query.data}>
        {query.data ? (
          <>
            <Card title="Next step">
              <div className="next-step">
                <div><strong>{nextStep.title}</strong><p className="muted">{nextStep.detail}</p></div>
                <a className="button primary" href={nextStep.href}>{nextStep.action}</a>
              </div>
            </Card>
            <div className="metrics">
              <div className="metric"><span>Treasury TestUSDC</span><strong>{query.data.safeBalance ?? "—"}</strong></div>
              <div className="metric"><span>Active agents</span><strong>{query.data.agents.active}/{query.data.agents.total}</strong></div>
              <div className="metric"><span>Needs review</span><strong>{query.data.pendingEscalations}</strong></div>
              <div className="metric"><span>Supplier list version</span><strong>{query.data.registryVersion}</strong></div>
            </div>
            <Card title="Treasury">
              {query.data.treasury ? (
                <table>
                  <tbody>
                    <tr><td>Treasury account</td><td><a href={explorerNear(query.data.treasury.daoAccountId)} target="_blank" rel="noreferrer">{query.data.treasury.daoAccountId}</a></td></tr>
                    <tr><td>Base account</td><td><a href={explorerBase(query.data.treasury.safeAddress)} target="_blank" rel="noreferrer">{query.data.treasury.safeAddress}</a></td></tr>
                    <tr><td>Status</td><td><Status value={query.data.treasury.status} /></td></tr>
                    <tr><td colSpan={2}><details><summary>Advanced</summary>
                      <div>Vault: <a href={explorerNear(query.data.treasury.vaultAccountId)} target="_blank" rel="noreferrer">{query.data.treasury.vaultAccountId}</a></div>
                      <div>Waiting-period contract: <a href={explorerBase(query.data.treasury.delayAddress)} target="_blank" rel="noreferrer">{query.data.treasury.delayAddress}</a></div>
                    </details></td></tr>
                  </tbody>
                </table>
              ) : <div className="state">No Treasury yet. <a href="/onboarding">Start setup</a>.</div>}
            </Card>
            <Card title="Members">
              {(members.data?.members.length ?? 0) === 0 ? (
                <div className="state">No members yet. <a href="/onboarding">Invite members</a>.</div>
              ) : (
                <table>
                  <thead><tr><th>Member</th><th>Role</th><th>Wallet status</th></tr></thead>
                  <tbody>
                    {members.data?.members.map((item) => (
                      <tr key={item.id}>
                        <td>{item.name ?? item.email ?? item.id}</td>
                        <td>{item.role}</td>
                        <td>
                          {item.walletProofApprovedAt
                            ? "Approved"
                            : item.walletProofVerifiedAt
                              ? "Waiting for admin review"
                              : "Waiting for wallet verification"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Spending permissions">
              {query.data.roleBudgets.length === 0 ? <div className="state">No spending permission yet. <a href="/onboarding">Create one</a>.</div> : (
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
              {query.data.operations.length === 0 ? <div className="state">No operations yet. <a href="/agents">Connect an agent</a>.</div> : (
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
