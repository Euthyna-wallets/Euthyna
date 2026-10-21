import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../api.js";
import { Card, PageState, short } from "../components/ui.js";
import { signDaoVote } from "../wallets.js";

interface Governance {
  proposals: Array<{ id: number; description?: string; status?: string; votes?: Record<string, string> }>;
  daoAccountId: string | null;
  delay: { address: string; cooldownSeconds: number } | null;
  error?: string;
}

export function GovernancePage() {
  const query = useQuery({ queryKey: ["governance"], queryFn: () => api<Governance>("/v1/console/governance"), refetchInterval: 10_000 });
  const [signer, setSigner] = useState("");
  const [hashes, setHashes] = useState<string[]>([]);
  return (
    <div className="page">
      <header className="page-head"><div><h1>Governance</h1><p className="muted">DAO proposals and the Base Delay queue.</p></div></header>
      <Card title="Delay">
        {query.data?.delay ? (
          <p>Delay <span className="mono">{query.data.delay.address}</span> · cooldown {query.data.delay.cooldownSeconds}s.</p>
        ) : <div className="state">No Delay information.</div>}
      </Card>
      <Card title="DAO proposals">
        <PageState loading={query.isLoading} error={query.error} empty={query.data?.proposals.length === 0}>
          <div className="row"><input placeholder="your NEAR account" value={signer} onChange={(event) => setSigner(event.target.value)} /></div>
          <table>
            <thead><tr><th>ID</th><th>Description</th><th>Status</th><th>Votes</th><th /></tr></thead>
            <tbody>
              {(query.data?.proposals ?? []).map((proposal) => (
                <tr key={proposal.id}>
                  <td>{proposal.id}</td>
                  <td>{proposal.description ?? "—"}</td>
                  <td>{String(proposal.status ?? "—")}</td>
                  <td className="mono small">{JSON.stringify(proposal.votes ?? {})}</td>
                  <td>
                    <button className="ghost" disabled={!signer} onClick={() => {
                      void signDaoVote(signer, query.data?.daoAccountId ?? "", proposal.id).then((hash) => setHashes((current) => [...current, hash]));
                    }}>Vote</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hashes.length ? <pre>{hashes.join("\n")}</pre> : null}
        </PageState>
      </Card>
    </div>
  );
}
