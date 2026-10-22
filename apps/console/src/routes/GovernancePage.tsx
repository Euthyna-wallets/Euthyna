import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, type TreasuryView } from "../api.js";
import { Card, PageState, Status, short } from "../components/ui.js";
import {
  buildDelayVetoBatch,
  executeSafeBatch,
  signSafeBatch,
  type SafeBatch,
  type SafeBatchSignature,
} from "../safe.js";
import { nearAccounts, signDaoVote } from "../wallets.js";

interface GovernanceOperation {
  opId: string;
  proposalId: number | null;
  state: string;
  txHash: string | null;
  queueNonce: string | null;
  executeTxHash: string | null;
  countdownSeconds: string;
  cooldownEndsAt: string | null;
  expiresAt: string | null;
  lastError: string | null;
}

interface Governance {
  proposals: Array<{ id: number; description?: string; kind?: unknown; status?: string; votes?: Record<string, string> }>;
  operations: GovernanceOperation[];
  daoAccountId: string | null;
  treasury: TreasuryView | null;
  delay: {
    address: string;
    txNonce: string;
    queueNonce: string;
    cooldownSeconds: string;
    expirationSeconds: string;
    safeThreshold: string;
    currentTimestamp: string;
  } | null;
  error?: string;
}

type VetoState = { batch: SafeBatch; signatures: SafeBatchSignature[] };

function timelineState(operation: GovernanceOperation): Array<{ label: string; done: boolean }> {
  const terminal = ["Executed", "Vetoed", "Expired", "Failed", "Confirmed"].includes(operation.state);
  return [
    { label: "DAO vote", done: operation.proposalId !== null },
    { label: "Signed by 0xGOV", done: operation.txHash !== null || operation.state !== "PossiblySigned" },
    { label: "Broadcast", done: operation.txHash !== null },
    { label: "Delay queue", done: operation.queueNonce !== null },
    { label: operation.state, done: terminal },
  ];
}

export function GovernancePage() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["governance"],
    queryFn: () => api<Governance>("/v1/console/governance"),
    refetchInterval: 5_000,
  });
  const [signer, setSigner] = useState("");
  const [hashes, setHashes] = useState<string[]>([]);
  const [vetoes, setVetoes] = useState<Record<string, VetoState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function prepareVeto(operation: GovernanceOperation): Promise<VetoState> {
    const treasury = query.data?.treasury;
    const delay = query.data?.delay;
    if (!treasury || !delay) throw new Error("Treasury or Delay state unavailable");
    const batch = await buildDelayVetoBatch(treasury, BigInt(delay.queueNonce));
    const state = { batch, signatures: [] };
    setVetoes((current) => ({ ...current, [operation.opId]: state }));
    return state;
  }

  async function signVeto(operation: GovernanceOperation) {
    setBusy(operation.opId);
    setError(null);
    try {
      const current = vetoes[operation.opId] ?? await prepareVeto(operation);
      const signature = await signSafeBatch(current.batch);
      setVetoes((all) => ({
        ...all,
        [operation.opId]: {
          batch: current.batch,
          signatures: [
            ...current.signatures.filter((item) => item.owner !== signature.owner),
            signature,
          ],
        },
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function executeVeto(operation: GovernanceOperation) {
    const current = vetoes[operation.opId];
    const threshold = Number(query.data?.delay?.safeThreshold ?? 0);
    if (!current || current.signatures.length < threshold) throw new Error("Safe threshold not reached");
    setBusy(operation.opId);
    setError(null);
    try {
      const hash = await executeSafeBatch(current.batch, current.signatures);
      setHashes((existing) => [...existing, hash]);
      await client.invalidateQueries({ queryKey: ["governance"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Governance</h1>
          <p className="muted">DAO vote → 0xGOV → Delay → Safe → Roles.</p>
        </div>
      </header>
      {error || query.data?.error ? <div className="alert error">{error ?? query.data?.error}</div> : null}
      <Card title="Delay — on-chain state">
        {query.data?.delay ? (
          <table>
            <tbody>
              <tr><td>Address</td><td className="mono">{query.data.delay.address}</td></tr>
              <tr><td>Cooldown</td><td>{query.data.delay.cooldownSeconds}s</td></tr>
              <tr><td>Expiration</td><td>{query.data.delay.expirationSeconds}s</td></tr>
              <tr><td>txNonce / queueNonce</td><td>{query.data.delay.txNonce} / {query.data.delay.queueNonce}</td></tr>
              <tr><td>Safe threshold</td><td>{query.data.delay.safeThreshold}</td></tr>
            </tbody>
          </table>
        ) : <div className="state">No Delay information.</div>}
      </Card>
      <Card title="Governance operations">
        <PageState loading={query.isLoading} error={query.error} empty={query.data?.operations.length === 0}>
          <div className="stack">
            {(query.data?.operations ?? []).map((operation) => {
              const veto = vetoes[operation.opId];
              const threshold = Number(query.data?.delay?.safeThreshold ?? 0);
              const vetoable = operation.state === "Queued" && operation.queueNonce !== null;
              return (
                <div className="step" key={operation.opId}>
                  <div className="row wrap">
                    <strong className="mono">{short(operation.opId)}</strong>
                    <Status value={operation.state} />
                    {operation.queueNonce !== null ? <span className="pill">Delay #{operation.queueNonce}</span> : null}
                    {operation.state === "Queued" ? <span className="pill">{operation.countdownSeconds}s remaining</span> : null}
                  </div>
                  <div className="row wrap">
                    {timelineState(operation).map((stage, index) => (
                      <span key={stage.label} className={`pill ${stage.done ? "success" : ""}`}>
                        {index > 0 ? "→ " : ""}{stage.label}
                      </span>
                    ))}
                  </div>
                  {operation.txHash ? <div className="mono small">queue tx {operation.txHash}</div> : null}
                  {operation.executeTxHash ? <div className="mono small">execute tx {operation.executeTxHash}</div> : null}
                  {operation.lastError ? <div className="alert error">{operation.lastError}</div> : null}
                  {vetoable ? (
                    <div className="row wrap">
                      <button className="ghost" disabled={busy === operation.opId} onClick={() => void signVeto(operation)}>
                        Veto — sign with council wallet
                      </button>
                      <span>{veto?.signatures.length ?? 0}/{threshold} Safe signatures</span>
                      <button
                        className="primary"
                        disabled={!veto || veto.signatures.length < threshold || busy === operation.opId}
                        onClick={() => void executeVeto(operation)}
                      >
                        Execute veto
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </PageState>
      </Card>
      <Card title="DAO proposals">
        <PageState loading={query.isLoading} error={query.error} empty={query.data?.proposals.length === 0}>
          <div className="row">
            <input placeholder="your NEAR account" value={signer} onChange={(event) => setSigner(event.target.value)} />
            <button className="ghost" onClick={() => void nearAccounts().then((accounts) => setSigner(accounts[0] ?? ""))}>
              Use connected NEAR account
            </button>
          </div>
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
                      void signDaoVote(signer, query.data?.daoAccountId ?? "", proposal.id, proposal.kind)
                        .then((hash) => setHashes((current) => [...current, hash]));
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
