import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { api } from "../api.js";
import { PaymentTrace, type TraceStep } from "../components/PaymentTrace.js";
import { Card, PageState, Status, short } from "../components/ui.js";
import { formatToken } from "../lib/format.js";

interface Detail {
  operation: { opId: string; reference: string; amount: string; state: string; txHash: string | null; lastError: string | null };
  escalation: { id: string; status: string; reasons: unknown } | null;
  visa: { visa: unknown } | null;
  timeline: TraceStep[];
}

export function PaymentDetailPage() {
  const { opId = "" } = useParams();
  const query = useQuery({ queryKey: ["operation", opId], queryFn: () => api<Detail>(`/v1/console/operations/${opId}`), refetchInterval: 10_000 });
  return (
    <div className="page">
      <header className="page-head"><div><h1>Payment trace</h1><p className="muted"><Link to="/payments">← Payments</Link></p></div></header>
      <PageState loading={query.isLoading} error={query.error} empty={!query.data}>
        {query.data ? (
          <>
            <div className="metrics">
              <div className="metric"><span>Reference</span><strong>{query.data.operation.reference}</strong></div>
              <div className="metric"><span>Amount</span><strong className="mono">{formatToken(query.data.operation.amount)}</strong></div>
              <div className="metric"><span>State</span><strong><Status value={query.data.operation.state} /></strong></div>
              <div className="metric"><span>Op</span><strong className="mono small">{short(query.data.operation.opId)}</strong></div>
            </div>
            <Card title="Three locks"><PaymentTrace steps={query.data.timeline} /></Card>
            {query.data.escalation ? <Card title="Escalation"><pre>{JSON.stringify(query.data.escalation, null, 2)}</pre></Card> : null}
            {query.data.visa ? <Card title="Guard visa"><pre>{JSON.stringify(query.data.visa, null, 2)}</pre></Card> : null}
            {query.data.operation.lastError ? <div className="state error">{query.data.operation.lastError}</div> : null}
          </>
        ) : null}
      </PageState>
    </div>
  );
}
