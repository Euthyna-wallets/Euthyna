import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Card, PageState, Status, short } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type ProposalDraft, type Sentence } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";
import { SentenceList } from "./GovernancePage.js";
import { verifyTransactions, type Requested } from "./WalletPage.js";

export function ActivityPage() {
  const query = useQuery({ queryKey: ["omni-activity"], queryFn: omni.activity, refetchInterval: 10_000 });
  const items = query.data?.items ?? [];
  const refused = items.filter((item) => item.kind === "refusal").length;
  const allowed = items.filter((item) => item.kind === "allowed").length;
  const executed = items.filter((item) => item.kind === "operation").length;
  const requests = items.filter((item) => item.kind === "request").length;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="muted">Every operation agents asked for: what the vault signed, and what it refused and why.</p>
        </div>
        <div className="pill">{allowed} allowed · {refused} refused · {executed} executed{requests ? ` · ${requests} asking the members` : ""}</div>
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
                  <td><Status value={item.kind === "refusal" ? "rejected" : item.kind === "allowed" ? "approved" : item.kind === "request" ? "pending" : item.state} /></td>
                  <td className="small">
                    {item.kind === "request"
                      ? (
                        <span>
                          {item.summary ? <><strong>{item.summary}</strong><br /></> : null}
                          <span className="muted">{item.reason}</span>
                          {item.request ? <><br /><AskMembers request={item.request} title={`${item.agent} asks: ${item.summary ?? "a transaction"}`} /></> : null}
                        </span>
                      )
                      : item.kind === "refusal"
                      ? (
                        <span>
                          {item.summary ? <><strong>{item.summary}</strong><br /></> : null}Refused: {item.reason}
                          {item.request ? <><br /><AskMembers request={item.request} title={`${item.agent}: ${item.summary ?? "refused request"}`} /></> : null}
                        </span>
                      )
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

/** A refused request is not lost: members can vote on exactly that transaction. */
function AskMembers(props: { request: Requested; title: string }) {
  const wallets = useWallets();
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status, staleTime: 60_000 });
  const [state, setState] = useState<{ busy: boolean; message: string | null; preview: { draft: ProposalDraft; summary: Sentence[] } | null }>({ busy: false, message: null, preview: null });
  const treasury = status.data?.treasury;
  const act = (action: () => Promise<void>) => {
    setState((current) => ({ ...current, busy: true, message: null }));
    void action().catch((cause: unknown) => setState((current) => ({ ...current, message: cause instanceof Error ? cause.message : String(cause) })))
      .finally(() => setState((current) => ({ ...current, busy: false })));
  };
  if (!treasury || !wallets.nearAccountId) return null;
  if (state.preview) {
    return (
      <span className="stack">
        <SentenceList items={state.preview.summary} />
        <span className="row">
          <button className="ghost compact" onClick={() => setState({ busy: false, message: null, preview: null })}>Cancel</button>
          <button className="primary compact" disabled={state.busy} onClick={() => act(async () => {
            const result = await signDaoProposal(wallets.nearAccountId, state.preview!.draft);
            setState({ busy: false, message: `Proposal #${result.proposalId} submitted to the members.`, preview: null });
          })}>Submit to the members' vote</button>
        </span>
      </span>
    );
  }
  return (
    <span>
      <button className="ghost compact" disabled={state.busy} onClick={() => act(async () => {
        const requested = [{ chainId: props.request.chainId, to: props.request.to, value: props.request.value, data: props.request.data }];
        const draft = await omni.transactionProposal({ title: props.title.slice(0, 120), transactions: requested });
        setState({ busy: false, message: null, preview: { draft, summary: verifyTransactions(draft, requested, treasury.daoAccountId, treasury.vaultAccountId) } });
      })}>Ask the members</button>
      {state.message ? <span className="small"> {state.message}</span> : null}
    </span>
  );
}
