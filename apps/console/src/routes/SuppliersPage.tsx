import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../api.js";
import { authClient } from "../auth.js";
import { FourEyesActions } from "../components/FourEyesActions.js";
import { Card, PageState, short } from "../components/ui.js";
import { formatToken } from "../lib/format.js";

interface Registry {
  version: number;
  suppliers: Array<{ id: string; name: string; contact: string | null; wallets: Array<{ id: string; chainId: number; address: string }> }>;
  contracts: Array<{ id: string; reference: string; role: string; supplierId: string; maxAmount: string; periodicity: string; token: string }>;
  pendingChanges: Array<{ id: string; kind: string; payload: Record<string, unknown>; authorId: string; status: string }>;
}

const token = "0x418A2b47911dE05e21688F7490195F5324B49474";

export function SuppliersPage() {
  const session = authClient.useSession();
  const userId = session.data?.user.id ?? "";
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["registry"], queryFn: () => api<Registry>("/v1/console/registry"), refetchInterval: 10_000 });
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [address, setAddress] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [reference, setReference] = useState("");
  const [role, setRole] = useState("researcher");
  const [maxAmount, setMaxAmount] = useState("5000000");
  const refresh = () => client.invalidateQueries({ queryKey: ["registry"] });
  const request = useMutation({
    mutationFn: (input: { path: string; body: unknown }) => api(input.path, { method: "POST", body: JSON.stringify(input.body) }),
    onSuccess: refresh,
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "reject" }) =>
      api(`/v1/console/registry-changes/${id}/decision`, { method: "POST", body: JSON.stringify({ decision }) }),
    onSuccess: refresh,
  });

  return (
    <div className="page">
      <header className="page-head"><div><h1>Suppliers</h1><p className="muted">Registry version {query.data?.version ?? "—"}. Every change needs a second member.</p></div></header>
      <PageState loading={query.isLoading} error={query.error} empty={false}>
        {query.data ? (
          <>
            <Card title="Suppliers and wallets">
              <table>
                <thead><tr><th>Name</th><th>Contact</th><th>Wallets</th></tr></thead>
                <tbody>
                  {query.data.suppliers.map((supplier) => (
                    <tr key={supplier.id}>
                      <td>{supplier.name}</td>
                      <td>{supplier.contact ?? "—"}</td>
                      <td className="mono small">{supplier.wallets.map((wallet) => short(wallet.address)).join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {query.data.suppliers.length === 0 ? <div className="state">No supplier yet.</div> : null}
            </Card>
            <Card title="Contracts">
              <table>
                <thead><tr><th>Reference</th><th>Role</th><th>Cap</th><th>Period</th></tr></thead>
                <tbody>
                  {query.data.contracts.map((contract) => (
                    <tr key={contract.id}><td>{contract.reference}</td><td>{contract.role}</td><td className="mono">{formatToken(contract.maxAmount)}</td><td>{contract.periodicity}</td></tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Pending changes (four-eyes)">
              {query.data.pendingChanges.length === 0 ? <div className="state">No pending change.</div> : (
                <table>
                  <thead><tr><th>Kind</th><th>Payload</th><th>Author</th><th /></tr></thead>
                  <tbody>
                    {query.data.pendingChanges.map((change) => (
                      <tr key={change.id}>
                        <td>{change.kind}</td>
                        <td className="mono small">{JSON.stringify(change.payload)}</td>
                        <td className="mono small">{short(change.authorId)}</td>
                        <td>
                          <FourEyesActions
                            authorId={change.authorId}
                            currentUserId={userId}
                            pending={decide.isPending}
                            onDecide={(decision) => decide.mutate({ id: change.id, decision })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Request a supplier">
              <div className="row wrap">
                <input placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
                <input placeholder="Contact" value={contact} onChange={(event) => setContact(event.target.value)} />
                <input placeholder="0x wallet" value={address} onChange={(event) => setAddress(event.target.value)} />
                <button className="primary" disabled={request.isPending} onClick={() => request.mutate({ path: "/v1/console/suppliers", body: { name, contact, chainId: 84532, address } })}>Request supplier</button>
              </div>
            </Card>
            <Card title="Request a wallet or contract">
              <div className="row wrap">
                <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
                  <option value="">Supplier…</option>
                  {query.data.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
                </select>
                <input placeholder="new wallet 0x…" value={address} onChange={(event) => setAddress(event.target.value)} />
                <button className="ghost" disabled={!supplierId || request.isPending} onClick={() => request.mutate({ path: `/v1/console/suppliers/${supplierId}/wallets`, body: { chainId: 84532, address } })}>Request wallet</button>
              </div>
              <div className="row wrap">
                <input placeholder="reference" value={reference} onChange={(event) => setReference(event.target.value)} />
                <input placeholder="role" value={role} onChange={(event) => setRole(event.target.value)} />
                <input placeholder="max amount" value={maxAmount} onChange={(event) => setMaxAmount(event.target.value)} />
                <button className="ghost" disabled={!supplierId || request.isPending} onClick={() => request.mutate({ path: "/v1/console/contracts", body: { reference, role, supplierId, maxAmount, periodicity: "monthly", token } })}>Request contract</button>
              </div>
              {request.error ? <div className="state error">{request.error.message}</div> : null}
            </Card>
          </>
        ) : null}
      </PageState>
    </div>
  );
}
