import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Card, PageState, Status, short } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type ProposalDraft, type Sentence, type WalletIntegrity } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";
import { SentenceList } from "./GovernancePage.js";
import { verifyTransactions, type Requested } from "./WalletPage.js";

const EXPLORERS: Record<number, string> = { 84532: "https://sepolia.basescan.org", 11155111: "https://sepolia.etherscan.io", 8453: "https://basescan.org", 1: "https://etherscan.io" };
const NEAR_EXPLORER = "https://testnet.nearblocks.io";

export function ActivityPage() {
  const query = useQuery({ queryKey: ["omni-activity"], queryFn: omni.activity, refetchInterval: 10_000 });
  const operations = query.data?.operations ?? [];
  const requests = query.data?.requests ?? [];
  const executed = operations.filter((item) => item.evm?.status === "success").length;
  const refused = requests.filter((item) => item.kind === "refusal").length;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="muted">What the chains record: each operation as the vault signed it on NEAR, and its result on the EVM chain.</p>
        </div>
        <div className="pill">{executed} executed on-chain · {refused} refused</div>
      </header>

      {(query.data?.integrity ?? []).map((item) => <IntegrityBanner key={item.chainId} item={item} />)}

      <Card title="On-chain operations">
        <PageState loading={query.isLoading} error={query.error} empty={operations.length === 0} emptyContent={<div className="state">No operation signed yet.</div>}>
          <table>
            <thead><tr><th>When</th><th>By</th><th>What</th><th>Vault (NEAR)</th><th>{"Result (EVM)"}</th></tr></thead>
            <tbody>
              {operations.map((item) => (
                <tr key={item.opId}>
                  <td className="small">{new Date(item.at).toLocaleString()}</td>
                  <td>{item.actor}{item.role ? <div className="small muted">role "{item.role}"</div> : null}</td>
                  <td className="small">
                    {item.summary ? <strong>{item.summary}</strong> : <span className="mono">{short(item.opId)}</span>}
                    <div className="muted">{item.chain} · nonce {item.nonce}{item.reference ? ` · ${item.reference}` : ""}</div>
                  </td>
                  <td className="small">
                    <Status value={item.vaultState} />
                    {item.nearAuthorizationTxHash ? <div><a href={`${NEAR_EXPLORER}/txns/${item.nearAuthorizationTxHash}`} target="_blank" rel="noreferrer">NEAR tx {short(item.nearAuthorizationTxHash)}</a></div> : null}
                  </td>
                  <td className="small">
                    {item.evm ? (
                      <>
                        <span className={`evm-status ${item.evm.status === "success" ? "ok" : item.evm.status === "reverted" ? "bad" : ""}`}>
                          {item.evm.status === "success" ? "✓ executed" : item.evm.status === "reverted" ? "✗ reverted" : "not mined yet"}
                        </span>
                        <div><a href={`${EXPLORERS[item.chainId] ?? ""}/tx/${item.evm.hash}`} target="_blank" rel="noreferrer">{item.chain} tx {short(item.evm.hash)}</a></div>
                      </>
                    ) : <span className="muted">not signed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </PageState>
      </Card>

      <Card title="Refusals and dry runs">
        <p className="small muted">Recorded by MandateOS, not on chain: a refused request never becomes a transaction, and a dry run (check) moves nothing.</p>
        {requests.length === 0 ? <div className="state">Nothing yet.</div> : (
          <table>
            <thead><tr><th>When</th><th>Agent</th><th>What</th><th>Result</th></tr></thead>
            <tbody>
              {requests.map((item, index) => (
                <tr key={`${item.kind}-${item.at}-${index}`} className={item.kind === "refusal" ? "refused" : undefined}>
                  <td className="small">{new Date(item.at).toLocaleString()}</td>
                  <td>{item.agent}</td>
                  <td className="small">{item.summary ? <strong>{item.summary}</strong> : "—"}{item.reference ? <div className="mono muted">{item.reference}</div> : null}</td>
                  <td className="small">
                    {item.kind === "refusal" ? (
                      <span>
                        <Status value="rejected" /> {item.reason}
                        {item.request ? <><br /><AskMembers request={item.request} title={`${item.agent}: ${item.summary ?? "refused request"}`} /></> : null}
                      </span>
                    ) : <span><Status value="dry run" /> allowed by the role</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

/** Nonce check: the chain cannot count more transactions than the vault signed. */
function IntegrityBanner({ item }: { item: WalletIntegrity }) {
  if (item.status === "ok") {
    return (
      <div className="alert success small">
        ✓ {item.chain}: the wallet has sent {item.walletNonce} transaction{item.walletNonce === 1 ? "" : "s"}, exactly the number the vault signed. Nothing left the wallet outside MandateOS.
      </div>
    );
  }
  if (item.status === "pending") {
    return <div className="alert warning small">{item.chain}: {item.vaultNonce - (item.walletNonce ?? 0)} transaction(s) signed by the vault, not mined yet.</div>;
  }
  if (item.status === "alert") {
    return (
      <div className="alert error small">
        {item.chain}: the wallet has sent {item.walletNonce} transactions but the vault signed only {item.vaultNonce}. A transaction left {short(item.address)} outside MandateOS: check the explorer now.
      </div>
    );
  }
  return <div className="alert small">{item.chain}: could not read the wallet's nonce right now.</div>;
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
