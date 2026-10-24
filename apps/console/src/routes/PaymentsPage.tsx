import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api, type OperationRow } from "../api.js";
import { Card, PageState, Status, short } from "../components/ui.js";
import { formatToken } from "../lib/format.js";

const states = ["all", "Prepared", "PossiblySigned", "Broadcast", "Confirmed", "Escalated", "Rejected", "Cancelled", "Reverted"];

export function PaymentsPage() {
  const [filter, setFilter] = useState("all");
  const query = useQuery({ queryKey: ["operations"], queryFn: () => api<{ operations: OperationRow[] }>("/v1/console/operations"), refetchInterval: 10_000 });
  const rows = (query.data?.operations ?? []).filter((row) => filter === "all" || (row.status ?? row.state) === filter);
  return (
    <div className="page">
      <header className="page-head"><div><h1>Payments</h1><p className="muted">Every payment crosses three independent locks.</p></div></header>
      <Card title="Operations" action={<select value={filter} onChange={(event) => setFilter(event.target.value)}>{states.map((state) => <option key={state}>{state}</option>)}</select>}>
        <PageState loading={query.isLoading} error={query.error} empty={rows.length === 0} emptyContent={<div className="state empty-action">No payments yet. <Link className="button primary" to="/agents">Connect an agent</Link></div>}>
          <table>
            <thead><tr><th>Reference</th><th>Amount</th><th>Status</th><th>Base tx</th><th>Created</th><th /></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.opId}>
                  <td>{row.reference}</td>
                  <td className="mono">{formatToken(row.amount)}</td>
                  <td><Status value={row.status ?? row.state} /></td>
                  <td className="mono small">{short(row.txHash)}</td>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                  <td><Link to={`/payments/${row.opId}`}>Trace</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </PageState>
      </Card>
    </div>
  );
}
