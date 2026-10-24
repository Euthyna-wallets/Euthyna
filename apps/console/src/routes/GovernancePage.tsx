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
import { nearAccounts, readDaoProposalRpc, signDaoProposal, signDaoVote } from "../wallets.js";
import { demoWalletsEnabled } from "../lib/wallet-store.js";

interface GovernanceOperation {
  opId: string;
  proposalId: number | null;
  state: string;
  displayState: string;
  underpriced: boolean;
  maxFeePerGas: string | null;
  txHash: string | null;
  queueNonce: string | null;
  executeTxHash: string | null;
  cancellationTxHash: string | null;
  countdownSeconds: string;
  cooldownEndsAt: string | null;
  expiresAt: string | null;
  lastError: string | null;
}

interface Governance {
  proposals: Array<{ id: number; description?: string; kind?: unknown; status?: string; votes?: Record<string, string> }>;
  operations: GovernanceOperation[];
  daoAccountId: string | null;
  relayActiveOperation: string | null;
  treasury: TreasuryView | null;
  delay: {
    address: string;
    txNonce: string;
    queueNonce: string;
    cooldownSeconds: string;
    expirationSeconds: string;
    safeThreshold: string;
    currentTimestamp: string;
    baseFeePerGas: string | null;
  } | null;
  error?: string;
}

type VetoState = { batch: SafeBatch; signatures: SafeBatchSignature[] };

interface GovernanceProposal {
  receiverId: string;
  args: Record<string, unknown>;
  deposit: string;
  warnings: string[];
}

function relayAction(kind: unknown, relayAccountId: string | undefined): "propose" | "cancel_nonce" | null {
  if (!relayAccountId || !kind || typeof kind !== "object" || !("FunctionCall" in kind)) return null;
  const functionCall = kind.FunctionCall;
  if (!functionCall || typeof functionCall !== "object") return null;
  if (!("receiver_id" in functionCall) || functionCall.receiver_id !== relayAccountId) return null;
  if (!("actions" in functionCall) || !Array.isArray(functionCall.actions) || functionCall.actions.length !== 1) return null;
  const action = functionCall.actions[0];
  if (!action || typeof action !== "object" || !("method_name" in action)) return null;
  return action.method_name === "propose" || action.method_name === "cancel_nonce"
    ? action.method_name
    : null;
}

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
  const [lostOwner, setLostOwner] = useState("0x35150E37F032Fa3053fFEC849Ef7B392C7a0dA1e");
  const [replacementOwner, setReplacementOwner] = useState("0x1D693a4425bf7eD10FE7775E2b65b072019FFceb");
  const [thirdOwner, setThirdOwner] = useState("0x64f4F6D91B66e01A65e992B89719A6a1E6F501e8");
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

  async function signVeto(operation: GovernanceOperation, preferredOwner?: string) {
    setBusy(operation.opId);
    setError(null);
    try {
      const current = vetoes[operation.opId] ?? await prepareVeto(operation);
      const signature = await signSafeBatch(current.batch, preferredOwner);
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
      const hash = await executeSafeBatch(
        current.batch,
        current.signatures,
        demoWalletsEnabled() ? current.batch.owners?.[0] : undefined,
      );
      setHashes((existing) => [...existing, hash]);
      await client.invalidateQueries({ queryKey: ["governance"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function proposeRelayUnblock(operation: GovernanceOperation) {
    if (!signer) throw new Error("Connect a council NEAR account first");
    setBusy(operation.opId);
    setError(null);
    try {
      const proposal = await api<{
        receiverId: string;
        args: Record<string, unknown>;
        deposit: string;
      }>("/v1/console/governance/unblock-proposal", {
        method: "POST",
        body: JSON.stringify({ opId: operation.opId }),
      });
      const submitted = await signDaoProposal(signer, proposal);
      setHashes((existing) => [...existing, submitted.transactionHash]);
      await client.invalidateQueries({ queryKey: ["governance"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function proposeOwnerRecovery() {
    if (!signer) throw new Error("Connect a council NEAR account first");
    setBusy("swap-owner");
    setError(null);
    try {
      const proposal = await api<GovernanceProposal>("/v1/console/governance/swap-owner-proposal", {
        method: "POST",
        body: JSON.stringify({ oldOwner: lostOwner, newOwner: replacementOwner }),
      });
      if (proposal.warnings.length > 0) {
        setError(proposal.warnings.join(" "));
        return;
      }
      const submitted = await signDaoProposal(signer, proposal);
      setHashes((existing) => [...existing, submitted.transactionHash]);
      await client.invalidateQueries({ queryKey: ["governance"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function proposeThirdOwner() {
    if (!signer) throw new Error("Connect a council NEAR account first");
    setBusy("add-owner");
    setError(null);
    try {
      const proposal = await api<GovernanceProposal>("/v1/console/governance/add-owner-proposal", {
        method: "POST",
        body: JSON.stringify({ newOwner: thirdOwner }),
      });
      if (proposal.warnings.length > 0) {
        setError(proposal.warnings.join(" "));
        return;
      }
      const submitted = await signDaoProposal(signer, proposal);
      setHashes((existing) => [...existing, submitted.transactionHash]);
      await client.invalidateQueries({ queryKey: ["governance"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }


  async function proposeUnderpricedCancellation(operation: GovernanceOperation) {
    if (!signer) throw new Error("Connect a council NEAR account first");
    setBusy(`cancel-${operation.opId}`);
    setError(null);
    try {
      const proposal = await api<GovernanceProposal>("/v1/console/governance/cancel-underpriced-proposal", {
        method: "POST",
        body: JSON.stringify({ opId: operation.opId }),
      });
      if (proposal.warnings.length > 0) {
        setError(proposal.warnings.join(" "));
        return;
      }
      const submitted = await signDaoProposal(signer, proposal);
      setHashes((existing) => [...existing, submitted.transactionHash]);
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
          <div className="row">
            <input placeholder="your NEAR account" value={signer} onChange={(event) => setSigner(event.target.value)} />
            <button className="ghost" onClick={() => void nearAccounts().then((accounts) => setSigner(accounts[0] ?? ""))}>
              Use connected NEAR account
            </button>
          </div>
      <Card title="Safe owner recovery through relay + Delay">
        <p className="muted">Creates an unsigned DAO proposal. The relay must be idle; council votes remain required.</p>
        <div className="row wrap">
          <input aria-label="Lost Safe owner" value={lostOwner} onChange={(event) => setLostOwner(event.target.value)} />
          <input aria-label="Replacement Safe owner" value={replacementOwner} onChange={(event) => setReplacementOwner(event.target.value)} />
          <button
            className="primary"
            disabled={!signer || busy === "swap-owner" || Boolean(query.data?.relayActiveOperation)}
            onClick={() => void proposeOwnerRecovery()}
          >
            Propose Safe.swapOwner
          </button>
        </div>
        <div className="row wrap">
          <input aria-label="Third Safe owner" value={thirdOwner} onChange={(event) => setThirdOwner(event.target.value)} />
          <button
            className="primary"
            disabled={!signer || busy === "add-owner" || Boolean(query.data?.relayActiveOperation)}
            onClick={() => void proposeThirdOwner()}
          >
            Propose add owner + threshold 2/3
          </button>
        </div>
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
                    <Status value={operation.displayState} />
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
                  {operation.cancellationTxHash ? <div className="mono small">cancellation tx {operation.cancellationTxHash}</div> : null}
                  {operation.lastError ? <div className="alert error">{operation.lastError}</div> : null}
                  {operation.underpriced ? (
                    <div className="alert warning">
                      <strong>Underpriced</strong>
                      <div>
                        Current Base fee {query.data?.delay?.baseFeePerGas ?? "—"} exceeds transaction max fee {operation.maxFeePerGas ?? "—"}.
                      </div>
                      <button
                        className="primary"
                        disabled={!signer || busy === `cancel-${operation.opId}`}
                        onClick={() => void proposeUnderpricedCancellation(operation)}
                      >
                        Propose cancellation
                      </button>
                    </div>
                  ) : null}
                  {operation.state === "Failed" && operation.cancellationTxHash ? (
                    <div className="alert warning">
                      Cancellation confirmed. <a href="/mandates">Re-propose with fresh gas fees</a>.
                    </div>
                  ) : null}
                  {vetoable ? (
                    <div className="row wrap">
                      {demoWalletsEnabled() && !veto ? (
                        <button
                          className="ghost"
                          disabled={busy === operation.opId}
                          onClick={() => void prepareVeto(operation)}
                        >
                          Prepare veto signatures
                        </button>
                      ) : !demoWalletsEnabled() ? (
                        <button className="ghost" disabled={busy === operation.opId} onClick={() => void signVeto(operation)}>
                          Veto — sign with council wallet
                        </button>
                      ) : veto?.batch.owners?.filter((owner) =>
                        !veto.signatures.some((signature) => signature.owner.toLowerCase() === owner.toLowerCase())
                      ).map((owner) => (
                        <button
                          key={owner}
                          className="ghost"
                          disabled={busy === operation.opId}
                          onClick={() => void signVeto(operation, owner)}
                        >
                          Sign veto as {short(owner)}
                        </button>
                      ))}
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
                  {query.data?.relayActiveOperation?.toLowerCase() === operation.opId.toLowerCase()
                    && ["Vetoed", "Expired", "Failed", "Executed"].includes(operation.state) ? (
                    <div className="alert warning">
                      <strong>Relay blocked by this terminal operation.</strong>
                      <div>DAO fallback: propose <span className="mono">confirm_original</span>, then approve it with the council below.</div>
                      <button
                        className="ghost"
                        disabled={!signer || busy === operation.opId}
                        onClick={() => void proposeRelayUnblock(operation)}
                      >
                        Propose relay unblock
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
                        .then(async (hash) => {
                          const refreshed = await readDaoProposalRpc(
                            query.data?.daoAccountId ?? "",
                            proposal.id,
                          );
                          if (
                            refreshed.state === "Executed" &&
                            relayAction(proposal.kind, query.data?.treasury?.relayAccountId) !== null
                          ) {
                            await api("/v1/console/governance/relay-operation", {
                              method: "POST",
                              body: JSON.stringify({
                                proposalId: proposal.id,
                                nearTransactionHash: hash,
                                signerAccountId: signer,
                              }),
                            });
                          }
                          setHashes((current) => [...current, hash]);
                          await client.invalidateQueries({ queryKey: ["governance"] });
                        })
                        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
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
