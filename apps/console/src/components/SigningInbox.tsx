import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api, type TreasuryView } from "../api.js";
import { authClient } from "../auth.js";
import { approvalCount, proposalEffect, relayAction } from "../lib/governance-view.js";
import { useWallets } from "../lib/wallet-context.js";
import { readDaoProposalRpc, signDaoVote } from "../wallets.js";

interface InboxMember {
  id: string;
  userId: string;
  nearAccountId: string | null;
  walletProofVerifiedAt: string | null;
}

interface InboxProposal {
  id: number;
  description?: string;
  kind?: unknown;
  status?: string;
  votes?: Record<string, string>;
}

interface InboxGovernance {
  daoAccountId: string | null;
  treasury: TreasuryView | null;
  proposals: InboxProposal[];
  operations: Array<{ opId: string; state: string; queueNonce: string | null }>;
  delay: { safeThreshold: string } | null;
}

export function SigningInbox() {
  const session = authClient.useSession();
  const wallets = useWallets();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const members = useQuery({
    queryKey: ["members", "signing-inbox"],
    queryFn: () => api<{ members: InboxMember[] }>("/v1/console/members"),
    refetchInterval: 10_000,
  });
  const governance = useQuery({
    queryKey: ["governance"],
    queryFn: () => api<InboxGovernance>("/v1/console/governance"),
    refetchInterval: 5_000,
  });
  const member = members.data?.members.find((item) => item.userId === session.data?.user.id);
  const pendingVotes = (governance.data?.proposals ?? []).filter((proposal) => {
    if (proposal.status !== "InProgress" || !member?.nearAccountId) return false;
    return proposal.votes?.[member.nearAccountId] !== "Approve";
  });
  const proofPending = Boolean(member && !member.walletProofVerifiedAt);
  const vetoWindows = (governance.data?.operations ?? []).filter((operation) =>
    operation.state === "Queued" && operation.queueNonce !== null
  );
  const count = pendingVotes.length + (proofPending ? 1 : 0) + vetoWindows.length;

  async function vote(proposal: InboxProposal) {
    if (!governance.data?.daoAccountId || !member?.nearAccountId) return;
    if (wallets.nearAccountId !== member.nearAccountId || !wallets.nearConnected) {
      setError(`Connect ${member.nearAccountId} in the wallet bar first.`);
      return;
    }
    setBusy(proposal.id);
    setError(null);
    try {
      const transactionHash = await signDaoVote(
        member.nearAccountId,
        governance.data.daoAccountId,
        proposal.id,
        proposal.kind,
      );
      const refreshed = await readDaoProposalRpc(governance.data.daoAccountId, proposal.id);
      if (
        refreshed.state === "Executed" &&
        relayAction(proposal.kind, governance.data.treasury?.relayAccountId) !== null
      ) {
        await api("/v1/console/governance/relay-operation", {
          method: "POST",
          body: JSON.stringify({
            proposalId: proposal.id,
            nearTransactionHash: transactionHash,
            signerAccountId: member.nearAccountId,
          }),
        });
      }
      await client.invalidateQueries({ queryKey: ["governance"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="signing-inbox">
      <button className="inbox-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        À signer <span>{count}</span>
      </button>
      {open ? (
        <div className="inbox-popover">
          <div className="inbox-head">
            <strong>À signer pour vous</strong>
            <span>{member?.nearAccountId ?? "Wallet non prouvé"}</span>
          </div>
          {error ? <div className="alert error">{error}</div> : null}
          {proofPending && member ? (
            <Link className="inbox-item" to={`/onboarding?member=${member.id}`} onClick={() => setOpen(false)}>
              <span>Wallet proof</span><strong>Connecter et prouver</strong>
            </Link>
          ) : null}
          {pendingVotes.map((proposal) => (
            <div className="inbox-item" key={proposal.id}>
              <span>{proposalEffect({ ...proposal, relayAccountId: governance.data?.treasury?.relayAccountId })}</span>
              <small>{approvalCount(proposal.votes)}/{governance.data?.delay?.safeThreshold ?? "?"} approvals</small>
              <button disabled={busy !== null} onClick={() => void vote(proposal)}>
                {busy === proposal.id ? "Signature…" : "Voter"}
              </button>
            </div>
          ))}
          {vetoWindows.map((operation) => (
            <Link className="inbox-item" key={operation.opId} to="/governance" onClick={() => setOpen(false)}>
              <span>Opération dans le Delay</span><strong>Examiner le veto</strong>
            </Link>
          ))}
          {count === 0 ? <div className="inbox-empty">Rien à signer.</div> : null}
        </div>
      ) : null}
    </div>
  );
}
