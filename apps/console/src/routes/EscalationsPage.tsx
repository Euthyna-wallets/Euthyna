import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api.js";
import { SecondaryButton } from "../components/SecondaryButton.js";
import { Card, PageState, Status, short } from "../components/ui.js";
import { formatToken } from "../lib/format.js";

interface Escalation {
  id: string;
  opId: string;
  status: string;
  reasons: unknown;
  invoice: { recipient: number[]; amount: string; token: number[]; reference: string } | null;
  registrySnapshot: { token?: { address?: string }; roles?: Record<string, { maximumPayment?: string; vendors?: Array<{ addresses: Array<{ address: string }> }> }> } | null;
  createdAt: string;
}

function hex(bytes: number[] | undefined): string {
  return bytes ? `0x${bytes.map((value) => value.toString(16).padStart(2, "0")).join("")}` : "—";
}

export function EscalationsPage() {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["escalations"], queryFn: () => api<{ escalations: Escalation[] }>("/v1/console/escalations"), refetchInterval: 10_000 });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "reject" }) =>
      api(`/v1/console/escalations/${id}/decision`, { method: "POST", body: JSON.stringify({ decision }) }),
    onSuccess: () => {
      setSelected(null);
      void client.invalidateQueries({ queryKey: ["escalations"] });
    },
  });
  const rows = query.data?.escalations ?? [];
  const current = rows.find((row) => row.id === selected) ?? null;
  return (
    <div className="page">
      <header className="page-head"><div><h1>Escalations</h1><p className="muted">Invoice vs registry. A human re-checks; rules are never overridden.</p></div></header>
      <Card title="Pending queue">
        <PageState loading={query.isLoading} error={query.error} empty={rows.length === 0} emptyContent={<div className="state empty-action">Nothing needs review. <Link className="button primary" to="/payments">View payments</Link></div>}>
          <table>
            <thead><tr><th>Op</th><th>Status</th><th>Reasons</th><th>Created</th><th /></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono small">{short(row.opId)}</td>
                  <td><Status value={row.status} /></td>
                  <td>{Array.isArray(row.reasons) ? row.reasons.join(", ") : String(row.reasons)}</td>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                  <td><SecondaryButton onClick={() => setSelected(row.id)}>Compare</SecondaryButton></td>
                </tr>
              ))}
            </tbody>
          </table>
        </PageState>
      </Card>
      {current ? <EscalationDetail escalation={current} onDecide={decide.mutate} pending={decide.isPending} /> : null}
    </div>
  );
}

function EscalationDetail({ escalation, onDecide, pending }: { escalation: Escalation; onDecide: (input: { id: string; decision: "approve" | "reject" }) => void; pending: boolean }) {
  const role = Object.values(escalation.registrySnapshot?.roles ?? {})[0];
  const recipients = (role?.vendors ?? []).flatMap((vendor) => vendor.addresses.map((address) => address.address.toLowerCase()));
  const recipient = hex(escalation.invoice?.recipient).toLowerCase();
  const recipientMatches = recipients.includes(recipient);
  const amountMatches = escalation.invoice ? BigInt(escalation.invoice.amount) <= BigInt(role?.maximumPayment ?? "0") : false;
  return (
    <Card title="Invoice vs registry">
      <table className="compare">
        <thead><tr><th>Field</th><th>Invoice</th><th>Registry</th><th>Result</th></tr></thead>
        <tbody>
          <tr><td>Recipient</td><td className="mono small">{recipient}</td><td className="mono small">{recipients.join(", ") || "—"}</td><td>{recipientMatches ? "match" : "different"}</td></tr>
          <tr><td>Amount</td><td className="mono">{formatToken(escalation.invoice?.amount)}</td><td className="mono">{formatToken(role?.maximumPayment)}</td><td>{amountMatches ? "within cap" : "different"}</td></tr>
          <tr><td>Reference</td><td>{escalation.invoice?.reference ?? "—"}</td><td>—</td><td>review</td></tr>
        </tbody>
      </table>
      <p className="notice">Call the supplier back at the number in the registry before changing anything.</p>
      <div className="row wrap">
        <button className="primary" disabled={pending} title={pending ? "A review decision is being submitted" : "Re-check this payment against the approved supplier list"} onClick={() => onDecide({ id: escalation.id, decision: "approve" })}>Re-check</button>
        <SecondaryButton disabled={pending} title={pending ? "A review decision is being submitted" : "Reject this payment"} onClick={() => onDecide({ id: escalation.id, decision: "reject" })}>Reject</SecondaryButton>
        <span className="muted small">Registry corrections use a separate four-eyes change.</span>
      </div>
    </Card>
  );
}
