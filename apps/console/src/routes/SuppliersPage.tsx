import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../api.js";
import { authClient } from "../auth.js";
import { FourEyesActions } from "../components/FourEyesActions.js";
import { Card, PageState } from "../components/ui.js";

interface Registry {
  version: number;
  suppliers: Array<{ id: string; name: string; contact: string | null; wallets: Array<{ id: string; chainId: number; address: string }> }>;
  pendingChanges: Array<{ id: string; kind: string; payload: Record<string, unknown>; authorId: string; status: string }>;
}

const CHAIN_ID = 84532;

function describeChange(change: Registry["pendingChanges"][number], suppliers: Registry["suppliers"]): string {
  const payload = change.payload;
  if (change.kind === "supplier_create") return `Add supplier ${String(payload.name)} paid at ${String(payload.address)}`;
  if (change.kind === "wallet_add") {
    const supplier = suppliers.find((item) => item.id === payload.supplierId);
    return `Add wallet ${String(payload.address)} to ${supplier?.name ?? "a supplier"}`;
  }
  return change.kind;
}

/**
 * Suppliers are the only transfer recipients the Guard accepts. Each change
 * needs a second member: the author cannot approve their own request.
 */
export function SuppliersPage() {
  const session = authClient.useSession();
  const userId = session.data?.user.id ?? "";
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["registry"], queryFn: () => api<Registry>("/v1/console/registry"), refetchInterval: 10_000 });
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [address, setAddress] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
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
  const validAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value.trim());

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Suppliers</h1>
          <p className="muted">
            The only addresses an agent may pay, on top of what its role allows. Every change needs a second member.
          </p>
        </div>
      </header>
      <PageState loading={query.isLoading} error={query.error} empty={false}>
        {query.data ? (
          <>
            <Card title={`Waiting for a second member (${query.data.pendingChanges.length})`}>
              {query.data.pendingChanges.length === 0 ? <div className="state">Nothing waiting.</div> : (
                <table>
                  <tbody>
                    {query.data.pendingChanges.map((change) => (
                      <tr key={change.id}>
                        <td className="small">{describeChange(change, query.data.suppliers)}</td>
                        <td className="small muted">{change.authorId === userId ? "requested by you" : "requested by another member"}</td>
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
            <Card title="Suppliers">
              {query.data.suppliers.length === 0 ? <div className="state">No supplier yet.</div> : (
                <table>
                  <thead><tr><th>Name</th><th>Contact</th><th>Wallets (Base Sepolia)</th></tr></thead>
                  <tbody>
                    {query.data.suppliers.map((supplier) => (
                      <tr key={supplier.id}>
                        <td>{supplier.name}</td>
                        <td>{supplier.contact ?? "—"}</td>
                        <td className="mono small">{supplier.wallets.map((wallet) => wallet.address).join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Request a change">
              <div className="row wrap">
                <input placeholder="Supplier name" value={name} onChange={(event) => setName(event.target.value)} />
                <input placeholder="Contact (optional)" value={contact} onChange={(event) => setContact(event.target.value)} />
                <input placeholder="0x… wallet" value={address} onChange={(event) => setAddress(event.target.value)} />
                <button
                  className="primary"
                  disabled={request.isPending || !name.trim() || !validAddress(address)}
                  onClick={() => request.mutate({ path: "/v1/console/suppliers", body: { name: name.trim(), ...(contact.trim() ? { contact: contact.trim() } : {}), chainId: CHAIN_ID, address: address.trim() } })}
                >
                  Request new supplier
                </button>
              </div>
              <div className="row wrap">
                <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
                  <option value="">Supplier…</option>
                  {query.data.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
                </select>
                <input placeholder="0x… new wallet" value={walletAddress} onChange={(event) => setWalletAddress(event.target.value)} />
                <button
                  className="ghost"
                  disabled={!supplierId || request.isPending || !validAddress(walletAddress)}
                  onClick={() => request.mutate({ path: `/v1/console/suppliers/${supplierId}/wallets`, body: { chainId: CHAIN_ID, address: walletAddress.trim() } })}
                >
                  Request wallet
                </button>
              </div>
              {request.error ? <div className="alert error">{request.error.message}</div> : null}
            </Card>
          </>
        ) : null}
      </PageState>
    </div>
  );
}
