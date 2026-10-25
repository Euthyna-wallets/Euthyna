import { useQuery } from "@tanstack/react-query";

import { Card, PageState, Status, short } from "../components/ui.js";
import { omni } from "../omniroles-api.js";

export function ActivityPage() {
  const query = useQuery({ queryKey: ["omni-activity"], queryFn: omni.activity, refetchInterval: 10_000 });
  const items = query.data?.items ?? [];
  const refused = items.filter((item) => item.kind === "refusal").length;
  const allowed = items.filter((item) => item.kind === "allowed").length;
  const executed = items.filter((item) => item.kind === "operation").length;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="muted">Every operation agents asked for: what the vault signed, and what it refused and why.</p>
        </div>
        <div className="pill">{allowed} allowed · {refused} refused · {executed} executed</div>
      </header>
      <Card title="Operations">
        <PageState loading={query.isLoading} error={query.error} empty={items.length === 0} emptyContent={<div className="state">No operation yet. Agents' requests appear here, including the ones the vault refuses.</div>}>
          <table>
            <thead><tr><th>When</th><th>Agent</th><th>Reference</th><th>Result</th><th>Details</th></tr></thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={`${item.kind}-${item.opId ?? item.reference}-${index}`} className={item.kind === "refusal" ? "refused" : item.kind === "allowed" ? "allowed" : undefined}>
                  <td className="small">{new Date(item.at).toLocaleString()}</td>
                  <td>{item.agent}</td>
                  <td className="mono small">{item.reference || "—"}</td>
                  <td><Status value={item.kind === "refusal" ? "rejected" : item.kind === "allowed" ? "approved" : item.state} /></td>
                  <td className="small">
                    {item.kind === "refusal"
                      ? <span>{item.summary ? <><strong>{item.summary}</strong><br /></> : null}Refused: {item.reason}</span>
                      : item.kind === "allowed"
                        ? <span>{item.summary ? <><strong>{item.summary}</strong><br /></> : null}Allowed by the role</span>
                        : (
                        <span className="row wrap">
                          {item.txHash ? <a href={`https://sepolia.basescan.org/tx/${item.txHash}`} target="_blank" rel="noreferrer">Base tx {short(item.txHash)}</a> : <span className="muted">Not broadcast yet</span>}
                        </span>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </PageState>
      </Card>
    </div>
  );
}
