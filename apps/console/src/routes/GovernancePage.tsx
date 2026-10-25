import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { singleRoleTitle } from "../lib/role-summary.js";

import { BASE_SEPOLIA, budgetsOf, councilThreshold, decodeVaultCalls, describePolicyChange, describeVaultCall, type RuleChange } from "@mandateos/sdk/roles";

import { api } from "../api.js";
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
  // Rules queued by the same proposal share their queue time: show and veto them together.
  const groups = Object.values(waiting.reduce<Record<string, GovernanceRule[]>>((result, rule) => {
    (result[rule.queuedAt] ??= []).push(rule);
    return result;
  }, {})).map((rules) => rules.slice().reverse());
  const settled = (data?.rules ?? []).filter((rule) => rule.state !== "Queued");
  // Transactions voted outside any role, before they get their nonce.
  const scheduled = (data?.transactions ?? []).filter((transaction) => transaction.state === "Scheduled");

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
                  vaultAccountId={data!.vaultAccountId}
                  needed={needed}
                  me={me}
                  canVote={isMember && !(me in proposal.votes)}
                  busy={busy}
                  now={now}
                  onVote={(action) => run(`vote-${proposal.id}`, async () => {
                    await signDaoAction(me, data!.dao.accountId, proposal.id, proposal.kind, action);
                    if (action !== "VoteApprove") return `You rejected proposal #${proposal.id}.`;
                    const approved = await approveProposedSuppliers(proposal.kind);
                    return `You approved proposal #${proposal.id}.${approved ? ` ${approved} new supplier${approved > 1 ? "s" : ""} it pays registered with your approval.` : ""}`;
                  })}
                />
              ))}
            </div>
          )}
        </Card>

        <Card title={`Approved — veto window (${groups.length + scheduled.length})`}>
          {groups.length + scheduled.length === 0 ? <div className="state">No approved decision is waiting.</div> : (
            <div className="stack">
              {scheduled.map((transaction) => (
                <article key={transaction.opId} className="decision">
                  <header>
                    <div>
                      <span className="eyebrow">Transaction · {transaction.executesAt && Date.parse(transaction.executesAt) > now ? `signed ${relativeTime(transaction.executesAt, now)}` : "waiting for the wallet"}</span>
                      <h3>{transaction.title}</h3>
                    </div>
                  </header>
                  <SentenceList items={[{ title: transaction.details[0] ?? "", details: transaction.details.slice(1) }]} />
                  <footer className="row">
                    <span className="small muted">Any council member can stop it before it is signed.</span>
                    <div className="spacer" />
                    <button className="danger" disabled={!isMember || Boolean(busy)} onClick={() => void run(`veto-${transaction.opId}`, async () => {
                      await signVaultCall(me, data!.vaultAccountId, "veto_operation", { op_id: hexToBytes(transaction.opId) });
                      return "Transaction vetoed: it will not be signed.";
                    })}>Veto</button>
                  </footer>
                </article>
              ))}
              {groups.map((rules) => (
                <RuleCard
                  key={rules[0]!.queueId}
                  rules={rules}
                  now={now}
                  canVeto={isMember}
                  busy={busy}
                  onVeto={() => run(`veto-${rules[0]!.queueId}`, async () => {
                    for (const rule of rules) {
                      await signVaultCall(me, data!.vaultAccountId, "veto_rule_change", { queue_id: hexToBytes(rule.queueId) });
                    }
                    return "Decision vetoed: none of its changes will apply.";
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

        {data ? (
          <MembersCard
            members={data.dao.members}
            me={me}
            canPropose={isMember && !busy}
            onPropose={(next) => run("members", async () => {
              const { proposals } = await omni.membersProposals(next);
              verifyMembersDrafts(proposals, next, data.dao.accountId, data.vaultAccountId);
              for (const draft of proposals) await signDaoProposal(me, draft);
              return "Two proposals submitted: the DAO members, then the security council. Members vote on both.";
            })}
          />
        ) : null}

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

type Registry = {
  suppliers: Array<{ name: string; wallets: Array<{ chainId: number; address: string }> }>;
  pendingChanges?: Array<{ id: string; kind: string; authorId: string; payload: Record<string, unknown> }>;
};

/**
 * What a member approves is decoded here, in the browser, from the proposal
 * stored in the DAO. Sputnik only accepts a vote that repeats that exact
 * proposal, so a server that showed something else could not collect votes for it.
 * Supplier names come from MandateOS: the full address is printed next to each one.
 */
function useVerifiedChanges(proposal: GovernanceProposal, vaultAccountId: string): Sentence[] | null {
  const registry = useQuery({ queryKey: ["registry"], queryFn: () => api<Registry>("/v1/console/registry"), staleTime: 60_000 });
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status, staleTime: 60_000 });
  const policyChange = describePolicyChange(proposal.kind);
  if (policyChange) return [{ title: policyChange.title, details: policyChange.details }];
  const calls = decodeVaultCalls(proposal.kind as Parameters<typeof decodeVaultCalls>[0], vaultAccountId);
  if (!calls) return null;
  const labels: Record<string, string> = {};
  for (const supplier of registry.data?.suppliers ?? []) {
    for (const wallet of supplier.wallets) if (wallet.chainId === BASE_SEPOLIA.chainId) labels[wallet.address] = supplier.name;
  }
  for (const change of registry.data?.pendingChanges ?? []) {
    if (change.kind === "supplier_create" && typeof change.payload.address === "string") labels[change.payload.address] = `${String(change.payload.name)} (new supplier)`;
  }
  if (status.data?.wallet) labels[status.data.wallet.address] = "company wallet";
  const changes = calls.flatMap((call) => (call.method === "queue_rule_change" ? [call.change as RuleChange] : []));
  const context = { profile: BASE_SEPOLIA, labels, budgets: budgetsOf(changes, BASE_SEPOLIA), fullAddresses: true };
  return calls.map((call) => describeVaultCall(call, context));
}

function ProposalCard(props: {
  proposal: GovernanceProposal;
  vaultAccountId: string;
  needed: number;
  me: string;
  canVote: boolean;
  busy: string | null;
  now: number;
  onVote: (action: "VoteApprove" | "VoteReject") => void;
}) {
  const { proposal } = props;
  const verified = useVerifiedChanges(proposal, props.vaultAccountId);
  const approvals = Object.values(proposal.votes).filter((vote) => vote === "Approve").length;
  const rejections = Object.values(proposal.votes).filter((vote) => vote === "Reject").length;
  return (
    <article className="decision">
      <header>
        <div>
          <span className="eyebrow">Proposal #{proposal.id} · by {proposal.proposer}</span>
          <h3>{singleRoleTitle(proposal.changes) ?? proposal.title}</h3>
        </div>
        <div className="votes">
          <strong>{approvals} / {props.needed}</strong>
          <span className="small muted">approvals{rejections ? ` · ${rejections} against` : ""}</span>
        </div>
      </header>
      {verified ? (
        <>
          <SentenceList items={verified} />
          <p className="small muted verified">✓ Read in your browser from the proposal stored in the DAO. Your vote is only valid for exactly this content.</p>
        </>
      ) : (
        <div className="alert error">This proposal does not change this company's vault. Read it carefully before voting.<SentenceList items={proposal.changes} /></div>
      )}
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
  rules: GovernanceRule[];
  now: number;
  canVeto: boolean;
  busy: string | null;
  onVeto: () => void;
  onActivate: () => void;
}) {
  const first = props.rules[0]!;
  const ready = props.rules.every((rule) => rule.readyToActivate);
  return (
    <article className="decision">
      <header>
        <div>
          <span className="eyebrow">Approved · {ready ? "veto window over" : `applies ${relativeTime(first.activatesAt, props.now)}`}</span>
          <h3>{singleRoleTitle(props.rules) ?? (props.rules.length === 1 ? first.title : `${props.rules.length} changes approved together`)}</h3>
        </div>
      </header>
      <SentenceList items={props.rules.map((rule) => ({ title: rule.title, details: rule.details }))} />
      <footer className="row wrap">
        <span className="small muted">Applies at {new Date(first.activatesAt).toLocaleTimeString()} unless a council member vetoes it.</span>
        <div className="spacer" />
        {ready ? (
          <button className="primary" disabled={Boolean(props.busy)} onClick={props.onActivate}>Apply now</button>
        ) : (
          <button className="danger" disabled={!props.canVeto || Boolean(props.busy)} onClick={props.onVeto}>
            {props.busy === `veto-${first.queueId}` ? "Signing…" : "Veto"}
          </button>
        )}
      </footer>
    </article>
  );
}

export { hexToBytes };

/**
 * A recipient typed in the role builder is a supplier request waiting for a
 * second person (four-eyes). Approving the role that pays it is that second
 * look, so the voter's approval also registers it. The author of the request
 * cannot approve it: the API refuses, and that refusal is ignored here.
 */
async function approveProposedSuppliers(kind: unknown): Promise<number> {
  const registry = await api<Registry>("/v1/console/registry");
  const text = JSON.stringify(kind).toLowerCase();
  const decoded = (() => {
    try {
      const calls = (kind as { FunctionCall?: { actions?: Array<{ args: string }> } })?.FunctionCall?.actions ?? [];
      return calls.map((action) => atob(action.args)).join(" ").toLowerCase();
    } catch {
      return text;
    }
  })();
  let approved = 0;
  for (const change of registry.pendingChanges ?? []) {
    const address = typeof change.payload.address === "string" ? change.payload.address.toLowerCase().slice(2) : null;
    if (change.kind !== "supplier_create" || !address || !decoded.includes(address)) continue;
    const ok = await api(`/v1/console/registry-changes/${change.id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approve" }) })
      .then(() => true, () => false);
    if (ok) approved += 1;
  }
  return approved;
}

/** Refuse to sign member proposals that do not say exactly what was asked. */
function verifyMembersDrafts(drafts: Array<{ receiverId: string; args: { proposal: { kind: unknown } } }>, next: string[], dao: string, vault: string) {
  const [policyDraft, councilDraft] = drafts;
  const policy = policyDraft ? describePolicyChange(policyDraft.args.proposal.kind) : null;
  if (!policyDraft || policyDraft.receiverId !== dao || !policy || !policy.standard || policy.members.join() !== next.join()) {
    throw new Error("The members proposal prepared by the server does not match what you asked. Nothing was signed.");
  }
  const calls = councilDraft ? decodeVaultCalls(councilDraft.args.proposal.kind as Parameters<typeof decodeVaultCalls>[0], vault) : null;
  const council = calls?.length === 1 && calls[0]!.method === "queue_rule_change" && "SetCouncil" in calls[0]!.change ? calls[0]!.change.SetCouncil.members : null;
  if (!councilDraft || councilDraft.receiverId !== dao || !council || council.join() !== next.join()) {
    throw new Error("The security council proposal prepared by the server does not match. Nothing was signed.");
  }
}

function MembersCard(props: { members: string[]; me: string; canPropose: boolean; onPropose: (members: string[]) => void }) {
  const [next, setNext] = useState<string[] | null>(null);
  const [account, setAccount] = useState("");
  const list = next ?? props.members;
  const changed = next !== null && next.join() !== props.members.join();
  return (
    <Card title={`Members (${props.members.length})`}>
      <p className="muted small">
        The NEAR accounts that vote, veto and pause. Changing them is itself a decision: the DAO members apply when approved,
        the security council after the veto window.
      </p>
      <table>
        <tbody>
          {list.map((member) => (
            <tr key={member}>
              <td className="mono">{member}{member === props.me ? <span className="small muted"> (you)</span> : null}{!props.members.includes(member) ? <span className="small warn"> · to add</span> : null}</td>
              <td style={{ textAlign: "right" }}>
                <button className="ghost" disabled={!props.canPropose || list.length <= 3} title={list.length <= 3 ? "At least three members" : undefined} onClick={() => setNext(list.filter((item) => item !== member))}>Remove</button>
              </td>
            </tr>
          ))}
          {props.members.filter((member) => !list.includes(member)).map((member) => (
            <tr key={member}><td className="mono small muted"><s>{member}</s> · to remove</td><td /></tr>
          ))}
        </tbody>
      </table>
      <form className="row wrap" onSubmit={(event) => {
        event.preventDefault();
        const value = account.trim().toLowerCase();
        if (value && !list.includes(value)) setNext([...list, value]);
        setAccount("");
      }}>
        <input placeholder="new-member.testnet" value={account} onChange={(event) => setAccount(event.target.value)} />
        <button className="secondary" type="submit" disabled={!props.canPropose || account.trim().length < 2}>Add</button>
        <div className="spacer" />
        {changed ? (
          <>
            <span className="small">{list.length} members · {councilThreshold(list.length)} of {list.length} approvals</span>
            <button className="ghost" type="button" onClick={() => setNext(null)}>Undo</button>
            <button className="primary" type="button" disabled={!props.canPropose} onClick={() => { props.onPropose(list); setNext(null); }}>Propose this change</button>
          </>
        ) : null}
      </form>
    </Card>
  );
}
