import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Card, PageState, Status } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { approvalsNeeded, omni, thresholdText, type GovernanceProposal, type GovernanceRule, type Sentence } from "../omniroles-api.js";
import { signDaoAction, signDaoProposal, signVaultCall } from "../wallets.js";

function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Array.from({ length: clean.length / 2 }, (_, index) => Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16));
}

export function relativeTime(iso: string, now = Date.now()): string {
  const delta = new Date(iso).getTime() - now;
  const minutes = Math.round(Math.abs(delta) / 60_000);
  const text = minutes < 1 ? "less than a minute" : minutes < 90 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`;
  return delta >= 0 ? `in ${text}` : `${text} ago`;
}

export function SentenceList({ items }: { items: Sentence[] }) {
  return (
    <ul className="sentences">
      {items.map((item, index) => (
        <li key={`${item.title}-${index}`}>
          <strong>{item.title}</strong>
          {item.details.length ? (
            <ul>
              {item.details.map((detail, detailIndex) => (
                <li key={detailIndex} className={detail.startsWith("  · ") ? "rule" : undefined}>{detail.replace(/^ {2}· /, "")}</li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function GovernancePage() {
  const wallets = useWallets();
  const queryClient = useQueryClient();
  const now = useNow();
  const query = useQuery({ queryKey: ["omni-governance"], queryFn: omni.governance, refetchInterval: 10_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const data = query.data;
  const me = wallets.nearAccountId;
  const isMember = Boolean(data && me && data.dao.members.includes(me));
  const needed = data ? approvalsNeeded(data.dao.threshold, data.dao.members.length) : 0;

  async function run(label: string, action: () => Promise<string | void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const message = await action();
      if (message) setNotice(message);
      await queryClient.invalidateQueries({ queryKey: ["omni-governance"] });
      await queryClient.invalidateQueries({ queryKey: ["omni-roles"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const open = (data?.proposals ?? []).filter((proposal) => proposal.status === "InProgress");
  const closed = (data?.proposals ?? []).filter((proposal) => proposal.status !== "InProgress");
  const waiting = (data?.rules ?? []).filter((rule) => rule.state === "Queued");
  const settled = (data?.rules ?? []).filter((rule) => rule.state !== "Queued");

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Decisions</h1>
          <p className="muted">
            Members vote on every rule. An approved rule waits through a veto window, where any council member can stop it,
            then applies automatically. Agents never change rules.
          </p>
        </div>
        {data ? <div className="pill">{thresholdText(data.dao.threshold, data.dao.members.length)} approvals · {data.dao.members.length} members</div> : null}
      </header>
      {error ? <div className="alert error">{error}</div> : null}
      {notice ? <div className="alert success">{notice}</div> : null}
      {!me ? <div className="notice">Connect your NEAR wallet (top right) to vote or veto.</div> : null}
      {me && data && !isMember ? <div className="notice">{me} is not a member of this company's DAO: you can read decisions but not vote.</div> : null}

      <PageState loading={query.isLoading} error={query.error}>
        {data?.paused ? (
          <div className="alert error row wrap" style={{ justifyContent: "space-between" }}>
            <span><strong>Operations are paused.</strong> Agents cannot move funds until members vote to resume.</span>
            <button
              className="primary"
              disabled={!isMember || Boolean(busy)}
              onClick={() => void run("resume", async () => {
                const draft = await omni.pauseProposal(false);
                const result = await signDaoProposal(me, draft);
                return `Proposal #${result.proposalId} to resume operations submitted.`;
              })}
            >
              Propose to resume
            </button>
          </div>
        ) : null}

        <Card title={`Waiting for votes (${open.length})`}>
          {open.length === 0 ? <div className="state">No proposal is waiting for votes.</div> : (
            <div className="stack">
              {open.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  needed={needed}
                  me={me}
                  canVote={isMember && !(me in proposal.votes)}
                  busy={busy}
                  now={now}
                  onVote={(action) => run(`vote-${proposal.id}`, async () => {
                    await signDaoAction(me, data!.dao.accountId, proposal.id, proposal.kind, action);
                    return action === "VoteApprove" ? `You approved proposal #${proposal.id}.` : `You rejected proposal #${proposal.id}.`;
                  })}
                />
              ))}
            </div>
          )}
        </Card>

        <Card title={`Approved — veto window (${waiting.length})`}>
          {waiting.length === 0 ? <div className="state">No approved rule is waiting.</div> : (
            <div className="stack">
              {waiting.map((rule) => (
                <RuleCard
                  key={rule.queueId}
                  rule={rule}
                  now={now}
                  canVeto={isMember}
                  busy={busy}
                  onVeto={() => run(`veto-${rule.queueId}`, async () => {
                    await signVaultCall(me, data!.vaultAccountId, "veto_rule_change", { queue_id: hexToBytes(rule.queueId) });
                    return "Rule vetoed: it will not apply.";
                  })}
                  onActivate={() => run("activate", async () => {
                    const result = await omni.activate();
                    return result.transactions.length ? `${result.transactions.length} rule(s) activated.` : "Nothing to activate yet.";
                  })}
                />
              ))}
            </div>
          )}
        </Card>

        <Card title="Emergency">
          <div className="row wrap" style={{ justifyContent: "space-between" }}>
            <p className="muted" style={{ margin: 0 }}>
              Any council member can pause all agent operations immediately. Resuming needs a members' vote.
            </p>
            <button
              className="danger"
              disabled={!isMember || Boolean(busy) || data?.paused}
              onClick={() => void run("pause", async () => {
                await signVaultCall(me, data!.vaultAccountId, "pause", {});
                return "Operations paused.";
              })}
            >
              Pause all operations
            </button>
          </div>
        </Card>

        <Card title="History">
          {closed.length === 0 && settled.length === 0 ? <div className="state">No past decision.</div> : (
            <table>
              <thead><tr><th>Decision</th><th>Status</th><th>When</th></tr></thead>
              <tbody>
                {closed.map((proposal) => (
                  <tr key={`p-${proposal.id}`}>
                    <td>#{proposal.id} {proposal.title}</td>
                    <td><Status value={proposal.status === "Approved" ? "approved" : proposal.status.toLowerCase()} /></td>
                    <td className="small muted">{new Date(proposal.submittedAt).toLocaleString()}</td>
                  </tr>
                ))}
                {settled.map((rule) => (
                  <tr key={`r-${rule.queueId}`}>
                    <td>{rule.title}</td>
                    <td><Status value={rule.state === "Executed" ? "active" : rule.state === "Vetoed" ? "rejected" : rule.state.toLowerCase()} />{rule.vetoedBy ? <span className="small muted"> by {rule.vetoedBy}</span> : null}</td>
                    <td className="small muted">{new Date(rule.queuedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </PageState>
    </div>
  );
}

function ProposalCard(props: {
  proposal: GovernanceProposal;
  needed: number;
  me: string;
  canVote: boolean;
  busy: string | null;
  now: number;
  onVote: (action: "VoteApprove" | "VoteReject") => void;
}) {
  const { proposal } = props;
  const approvals = Object.values(proposal.votes).filter((vote) => vote === "Approve").length;
  const rejections = Object.values(proposal.votes).filter((vote) => vote === "Reject").length;
  return (
    <article className="decision">
      <header>
        <div>
          <span className="eyebrow">Proposal #{proposal.id} · by {proposal.proposer}</span>
          <h3>{proposal.title}</h3>
        </div>
        <div className="votes">
          <strong>{approvals} / {props.needed}</strong>
          <span className="small muted">approvals{rejections ? ` · ${rejections} against` : ""}</span>
        </div>
      </header>
      <SentenceList items={proposal.changes} />
      <footer className="row wrap">
        <span className="small muted">Expires {relativeTime(proposal.expiresAt, props.now)}</span>
        <span className="small muted">
          {Object.entries(proposal.votes).map(([voter, vote]) => `${voter}: ${vote}`).join(" · ") || "No vote yet"}
        </span>
        <div className="spacer" />
        {proposal.votes[props.me] ? <span className="small">You voted {proposal.votes[props.me]}</span> : null}
        <button className="ghost" disabled={!props.canVote || Boolean(props.busy)} onClick={() => props.onVote("VoteReject")}>Reject</button>
        <button className="primary" disabled={!props.canVote || Boolean(props.busy)} onClick={() => props.onVote("VoteApprove")}>
          {props.busy === `vote-${proposal.id}` ? "Signing…" : "Approve"}
        </button>
      </footer>
    </article>
  );
}

function RuleCard(props: {
  rule: GovernanceRule;
  now: number;
  canVeto: boolean;
  busy: string | null;
  onVeto: () => void;
  onActivate: () => void;
}) {
  const { rule } = props;
  return (
    <article className="decision">
      <header>
        <div>
          <span className="eyebrow">Approved · {rule.readyToActivate ? "veto window over" : `applies ${relativeTime(rule.activatesAt, props.now)}`}</span>
          <h3>{rule.title}</h3>
        </div>
      </header>
      {rule.details.length ? <SentenceList items={[{ title: "Details", details: rule.details }]} /> : null}
      <footer className="row wrap">
        <span className="small muted">Applies at {new Date(rule.activatesAt).toLocaleTimeString()} unless a council member vetoes it.</span>
        <div className="spacer" />
        {rule.readyToActivate ? (
          <button className="primary" disabled={Boolean(props.busy)} onClick={props.onActivate}>Apply now</button>
        ) : (
          <button className="danger" disabled={!props.canVeto || Boolean(props.busy)} onClick={props.onVeto}>
            {props.busy === `veto-${rule.queueId}` ? "Signing…" : "Veto"}
          </button>
        )}
      </footer>
    </article>
  );
}

export { hexToBytes };
