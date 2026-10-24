import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { Card, PageState, Status, short } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni } from "../omniroles-api.js";
import { TreasuryChecks } from "./TreasurySetup.js";

export function OverviewPage() {
  const wallets = useWallets();
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status, refetchInterval: 15_000 });
  const roles = useQuery({ queryKey: ["omni-roles"], queryFn: omni.roles, enabled: Boolean(status.data?.treasury), refetchInterval: 15_000 });
  const governance = useQuery({ queryKey: ["omni-governance"], queryFn: omni.governance, enabled: Boolean(status.data?.treasury), refetchInterval: 15_000 });
  const activity = useQuery({ queryKey: ["omni-activity"], queryFn: omni.activity, enabled: Boolean(status.data?.treasury), refetchInterval: 15_000 });
  const me = wallets.nearAccountId;
  const myVotes = (governance.data?.proposals ?? []).filter((proposal) => proposal.status === "InProgress" && !(me in proposal.votes)).length;
  const pendingRules = (governance.data?.rules ?? []).filter((rule) => rule.state === "Queued").length;
  const refused = (activity.data?.items ?? []).filter((item) => item.kind === "refusal").length;
  const executed = (activity.data?.items ?? []).filter((item) => item.kind === "operation").length;

  const loading = Boolean(status.data?.treasury) && (roles.isLoading || governance.isLoading || activity.isLoading);
  const count = (value: number) => (loading ? "…" : value);
  const next = loading
    ? { title: "Reading the vault…", detail: "Roles, decisions and activity are read from NEAR.", action: "Open roles", to: "/roles" }
    : !status.data?.treasury
    ? { title: "Finish the company setup", detail: "Members, treasury and wallet.", action: "Continue setup", to: "/onboarding" }
    : !status.data.wallet
      ? { title: "Create the company wallet", detail: "Members vote on the DAO's first decision.", action: "Continue setup", to: "/onboarding" }
      : myVotes > 0
        ? { title: `${myVotes} decision${myVotes > 1 ? "s" : ""} waiting for your vote`, detail: "Read what changes, then approve or reject.", action: "Open decisions", to: "/governance" }
        : (roles.data?.roles.length ?? 0) === 0
          ? { title: "Create the first role", detail: "Say what agents may do, with which budget.", action: "New role", to: "/roles" }
          : { title: "Watch agents work", detail: "Every operation, and every refusal with its reason.", action: "Open activity", to: "/activity" };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="muted">Humans set the constraints. Agents operate inside them.</p>
        </div>
      </header>
      <PageState loading={status.isLoading} error={status.error}>
        <Card title="Next step">
          <div className="next-step">
            <div><strong>{next.title}</strong><p className="muted">{next.detail}</p></div>
            <Link className="button primary" to={next.to}>{next.action}</Link>
          </div>
        </Card>
        {status.data?.treasury ? (
          <>
            <div className="metrics">
              <div className="metric"><span>Company wallet</span><strong className="mono">{status.data.wallet ? short(status.data.wallet.address, 6) : "not created"}</strong></div>
              <div className="metric"><span>Balance</span><strong>{status.data.wallet ? status.data.wallet.tokens.filter((token) => Number(token.amount) > 0).map((token) => `${Number(token.amount).toLocaleString()} ${token.symbol}`).join(" · ") || "empty" : "—"}</strong></div>
              <div className="metric"><span>Roles</span><strong>{count(roles.data?.roles.length ?? 0)}</strong></div>
              <div className="metric"><span>Rules in veto window</span><strong>{count(pendingRules)}</strong></div>
              <div className="metric"><span>Operations / refused</span><strong>{loading ? "…" : `${executed} / ${refused}`}</strong></div>
            </div>
            <Card title="Budgets">
              {roles.isLoading ? <div className="state">Loading…</div> : (roles.data?.roles ?? []).flatMap((role) => role.budgets).length === 0 ? <div className="state">No budget yet.</div> : (
                <table>
                  <thead><tr><th>Budget</th><th>Left this period</th><th>Refill</th></tr></thead>
                  <tbody>
                    {(roles.data?.roles ?? []).flatMap((role) => role.budgets.map((budget) => (
                      <tr key={`${role.name}-${budget.key}`}>
                        <td>{budget.label}</td>
                        <td>{Number(budget.available ?? 0).toLocaleString()} / {Number(budget.max ?? 0).toLocaleString()} {budget.token ?? ""}</td>
                        <td className="small muted">every {budget.periodDays} days</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Treasury" action={<Status value={status.data.treasury.status === "active" ? "active" : "pending"} />}>
              <div className="explain">
                <div><span className="eyebrow">DAO</span><strong className="mono small">{status.data.treasury.daoAccountId}</strong></div>
                <div><span className="eyebrow">Vault</span><strong className="mono small">{status.data.treasury.vaultAccountId}</strong></div>
              </div>
              <TreasuryChecks status={status.data} />
            </Card>
          </>
        ) : null}
      </PageState>
    </div>
  );
}
