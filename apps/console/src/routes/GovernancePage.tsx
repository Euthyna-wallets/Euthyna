import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api, type TreasuryView } from "../api.js";
import { Card, PageState, Status, short } from "../components/ui.js";
import {
  buildDelayVetoBatch,
  executeSafeBatch,
  signSafeBatch,
  type SafeBatch,
  type SafeBatchSignature,
} from "../safe.js";
import { readDaoProposalRpc, signDaoProposal, signDaoVote } from "../wallets.js";
import { demoWalletsEnabled } from "../lib/wallet-store.js";
import { approvalCount, proposalDecision, relayAction } from "../lib/governance-view.js";
import { useWallets } from "../lib/wallet-context.js";

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


function readableDuration(seconds: string): string {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "Unavailable";
  if (value < 60) return `${value} seconds`;
  if (value < 3_600) return `${Math.round(value / 60)} minutes`;
  return `${Math.round(value / 3_600)} hours`;
}

function timelineState(operation: GovernanceOperation): Array<{ label: string; done: boolean }> {
  const terminal = ["Executed", "Vetoed", "Expired", "Failed", "Confirmed"].includes(operation.state);
  const stages = [
    { label: "Voting", done: operation.proposalId !== null },
    { label: "Signed", done: operation.txHash !== null || operation.state !== "PossiblySigned" },
    { label: "Submitted", done: operation.txHash !== null },
    { label: "Waiting period", done: operation.queueNonce !== null },
  ];
  return terminal ? [...stages, { label: operation.state === "Confirmed" ? "Executed" : operation.state, done: true }] : stages;
}

export function GovernancePage() {
  const wallets = useWallets();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["governance"],
    queryFn: () => api<Governance>("/v1/console/governance"),
    refetchInterval: 5_000,
  });
  const members = useQuery({
    queryKey: ["members", "decisions"],
    queryFn: () => api<{ members: Array<{ evmAddress: string | null }> }>("/v1/console/members"),
    refetchInterval: 10_000,
  });
  const [signer, setSigner] = useState("");
  const [lostOwner, setLostOwner] = useState("0x35150E37F032Fa3053fFEC849Ef7B392C7a0dA1e");
  const [replacementOwner, setReplacementOwner] = useState("0x1D693a4425bf7eD10FE7775E2b65b072019FFceb");
  const [thirdOwner, setThirdOwner] = useState("0x64f4F6D91B66e01A65e992B89719A6a1E6F501e8");
  const [hashes, setHashes] = useState<string[]>([]);
  const [vetoes, setVetoes] = useState<Record<string, VetoState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const showAdvanced = demoWalletsEnabled() || new URLSearchParams(window.location.search).get("advanced") === "1";

  useEffect(() => {
    setSigner(wallets.nearAccountId);
  }, [wallets.nearAccountId]);

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
          <h1>Decisions</h1>
          <p className="muted">Review, approve and veto changes to your Treasury.</p>
        </div>
      </header>
      {error || query.data?.error ? <div className="alert error">{error ?? query.data?.error}</div> : null}
      <Card title="Waiting period">
        {query.data?.delay ? (
          <>
            <table>
              <tbody>
                <tr><td>Changes can execute after</td><td>{readableDuration(query.data.delay.cooldownSeconds)}</td></tr>
                <tr><td>Decision expires after</td><td>{readableDuration(query.data.delay.expirationSeconds)}</td></tr>
                <tr><td>Required approvals</td><td>{query.data.delay.safeThreshold}</td></tr>
              </tbody>
            </table>
            <details>
              <summary>Advanced</summary>
              <div className="mono small">{query.data.delay.address}</div>
              <div className="mono small">Queue {query.data.delay.txNonce} / {query.data.delay.queueNonce}</div>
            </details>
          </>
        ) : <div className="state">No waiting-period information.</div>}
      </Card>
      <div className="wallet-signing-context">
        <span>Decision signatures</span>
        <strong>{signer || "Connect a NEAR wallet in the global wallet bar"}</strong>
      </div>
      {showAdvanced ? (
      <Card title="Safe owner recovery through relay + Delay">
        <p className="muted">Creates an unsigned DAO proposal. The relay must be idle; council votes remain required.</p>
        <div className="row wrap">
          <input aria-label="Lost Safe owner" value={lostOwner} onChange={(event) => setLostOwner(event.target.value)} />
          <input aria-label="Replacement Safe owner" value={replacementOwner} onChange={(event) => setReplacementOwner(event.target.value)} />
          <button
            className="primary"
            disabled={!signer || busy === "swap-owner" || Boolean(query.data?.relayActiveOperation)}
            title={!signer ? "Connect your NEAR wallet" : query.data?.relayActiveOperation ? "Wait for the current decision to finish" : busy ? "A decision is being prepared" : "Prepare owner replacement"}
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
            title={!signer ? "Connect your NEAR wallet" : query.data?.relayActiveOperation ? "Wait for the current decision to finish" : busy ? "A decision is being prepared" : "Prepare owner addition"}
            onClick={() => void proposeThirdOwner()}
          >
            Propose add owner + threshold 2/3
          </button>
        </div>
      </Card>
      ) : null}
      <Card title="Decision progress">
        <PageState loading={query.isLoading} error={query.error} empty={query.data?.operations.length === 0} emptyContent={<div className="state empty-action">No decision is in its waiting period. <a className="button primary" href="/mandate">Create a spending permission</a></div>}>
          <div className="stack">
            {(query.data?.operations ?? []).map((operation) => {
              const veto = vetoes[operation.opId];
              const threshold = Number(query.data?.delay?.safeThreshold ?? 0);
              const vetoable = operation.state === "Queued" && operation.queueNonce !== null;
              return (
                <div className="step" key={operation.opId}>
                  <div className="row wrap">
                    <strong>Decision {operation.proposalId !== null ? `#${operation.proposalId}` : ""}</strong>
                    <Status value={operation.displayState} />
                    {operation.state === "Queued" ? <span className="pill">{readableDuration(operation.countdownSeconds)} remaining</span> : null}
                  </div>
                  <div className="row wrap">
                    {timelineState(operation).map((stage, index) => (
                      <span key={stage.label} className={`pill ${stage.done ? "success" : ""}`}>
                        {index > 0 ? "→ " : ""}{stage.label}
                      </span>
                    ))}
                  </div>
                  {(operation.txHash || operation.executeTxHash || operation.cancellationTxHash) ? (
                    <details>
                      <summary>Advanced transaction details</summary>
                      {operation.txHash ? <div className="mono small">queue tx {operation.txHash}</div> : null}
                      {operation.executeTxHash ? <div className="mono small">execute tx {operation.executeTxHash}</div> : null}
                      {operation.cancellationTxHash ? <div className="mono small">cancellation tx {operation.cancellationTxHash}</div> : null}
                    </details>
                  ) : null}
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
                        title={!signer ? "Connect your NEAR wallet" : busy ? "A cancellation is being prepared" : "Prepare cancellation for council approval"}
                        onClick={() => void proposeUnderpricedCancellation(operation)}
                      >
                        Propose cancellation
                      </button>
                    </div>
                  ) : null}
                  {operation.state === "Failed" && operation.cancellationTxHash ? (
                    <div className="alert warning">
                      Cancellation confirmed. <a href="/mandate">Re-propose with fresh gas fees</a>.
                    </div>
                  ) : null}
                  {vetoable ? (
                    <div className="row wrap">
                      {demoWalletsEnabled() && !veto ? (
                        <button
                          className="ghost"
                          disabled={busy === operation.opId}
                          title={busy === operation.opId ? "Wait for the current veto action" : "Prepare the council veto"}
                          onClick={() => void prepareVeto(operation)}
                        >
                          Prepare veto signatures
                        </button>
                      ) : !demoWalletsEnabled() ? (
                        <button className="ghost" disabled={busy === operation.opId} title={busy === operation.opId ? "Wait for the current veto signature" : "Sign the veto with your connected council wallet"} onClick={() => void signVeto(operation)}>
                          Veto — sign with council wallet
                        </button>
                      ) : veto?.batch.owners?.filter((owner) =>
                        !veto.signatures.some((signature) => signature.owner.toLowerCase() === owner.toLowerCase())
                      ).map((owner) => (
                        <button
                          key={owner}
                          className="ghost"
                          disabled={busy === operation.opId}
                          title={busy === operation.opId ? "Wait for the current veto signature" : `Sign as ${short(owner)}`}
                          onClick={() => void signVeto(operation, owner)}
                        >
                          Sign veto as {short(owner)}
                        </button>
                      ))}
                      <span>{veto?.signatures.length ?? 0}/{threshold} council signatures</span>
                      <button
                        className="primary"
                        disabled={!veto || veto.signatures.length < threshold || busy === operation.opId}
                        title={!veto ? "Collect council signatures first" : veto.signatures.length < threshold ? `${threshold - veto.signatures.length} more signature(s) required` : busy ? "Wait for the current veto action" : "Submit the signed veto"}
                        onClick={() => void executeVeto(operation)}
                      >
                        Execute veto
                      </button>
                    </div>
                  ) : null}
                  {query.data?.relayActiveOperation?.toLowerCase() === operation.opId.toLowerCase()
                    && ["Vetoed", "Expired", "Failed", "Executed"].includes(operation.state) ? (
                    <div className="alert warning">
                      <strong>The decision queue needs manual recovery.</strong>
                      <div>Prepare a council decision to release the completed item.</div>
                      <details><summary>Advanced</summary>Relay fallback: confirm the original operation.</details>
                      <button
                        className="ghost"
                        disabled={!signer || busy === operation.opId}
                        title={!signer ? "Connect your NEAR wallet" : busy ? "A decision is being prepared" : "Prepare the recovery decision"}
                        onClick={() => void proposeRelayUnblock(operation)}
                      >
                        Prepare recovery decision
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </PageState>
      </Card>
      <Card title="Council decisions">
        <PageState loading={query.isLoading} error={query.error} empty={query.data?.proposals.length === 0} emptyContent={<div className="state empty-action">No council decision yet. <a className="button primary" href="/mandate">Create a spending permission</a></div>}>
          <table>
            <thead><tr><th>Decision</th><th>Effect</th><th>Status</th><th>Approvals</th><th /></tr></thead>
            <tbody>
              {(query.data?.proposals ?? []).map((proposal) => {
                const approvals = approvalCount(proposal.votes);
                const threshold = Number(query.data?.delay?.safeThreshold ?? 2);
                const alreadyVoted = Boolean(signer && proposal.votes?.[signer]);
                const decision = proposalDecision({
                  kind: proposal.kind,
                  relayAccountId: query.data?.treasury?.relayAccountId,
                  knownEvmAddresses: members.data?.members?.flatMap((item) => item.evmAddress ? [item.evmAddress] : []),
                });
                const disabledReason = !signer
                  ? "Connect your NEAR wallet to approve"
                  : alreadyVoted
                    ? "You already approved this decision"
                    : null;
                return (
                <tr key={proposal.id}>
                  <td>#{proposal.id}</td>
                  <td className={decision.recognized ? "" : "effect-unrecognized"}>
                    <strong>{decision.title}</strong>
                    {decision.details.map((detail) => <div key={detail} className="small">{detail}</div>)}
                    {decision.warnings.map((warning) => <div key={warning} className="alert warning">{warning}</div>)}
                    <details><summary>Advanced</summary><code>{proposal.description ?? "No proposer note"}</code></details>
                  </td>
                  <td><Status value={String(proposal.status ?? "Unknown")} /></td>
                  <td>{approvals}/{threshold} approvals</td>
                  <td>
                    {proposal.status === "InProgress" ? (
                      <button
                        className="primary"
                        disabled={disabledReason !== null}
                        title={disabledReason ?? "Approve this decision"}
                        onClick={() => {
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
                        }}
                      >
                        {alreadyVoted ? "Approved" : "Approve"}
                      </button>
                    ) : null}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          {hashes.length ? <pre>{hashes.join("\n")}</pre> : null}
        </PageState>
      </Card>
    </div>
  );
}
