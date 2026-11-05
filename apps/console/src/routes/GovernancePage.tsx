import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { singleRoleTitle } from "../lib/role-summary.js";

import { BASE_SEPOLIA, budgetsOf, councilThreshold, decodeVaultCalls, describePolicyChange, describeRegistryProposal, describeSharesProposal, describeVaultCall, nearRecipient, stringHash, type RuleChange } from "@euthyna/sdk/roles";

import { api } from "../api.js";
import { displayAccount, PageState } from "../components/ui.js";
import { Kicker, NightPanel, PageTitle, Seal, SectionHead, Slab, VetoRing, VoteTokens } from "../components/design.js";
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

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

const darkDanger = {
  alignSelf: "flex-start",
  border: 0,
  background: "#B8442B",
  color: "#fff",
  padding: "9px 14px",
  font: "800 11px var(--font-brand)",
  letterSpacing: ".16em",
  cursor: "pointer",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,.25)",
} as const;

/** A decision's calls, one carved line each: marble slabs by day, night panels by night. */
function VoteLines({ items, dark = false }: { items: Sentence[]; dark?: boolean }) {
  const rule = dark ? "1px solid var(--night-line)" : "1px solid rgba(13,23,48,.1)";
  return (
    <div style={{ display: "flex", flexDirection: "column", borderTop: rule }}>
      {items.map((item, index) => (
        <div key={`${item.title}-${index}`} className="row-rule" style={{ gridTemplateColumns: "34px minmax(0, 1fr)", alignItems: "start", padding: "9px 0", borderBottom: rule, color: dark ? "var(--night-soft)" : "var(--ink)" }}>
          <b style={{ font: "700 13px var(--font-brand)", color: dark ? "var(--gold)" : "var(--gold-ink)" }}>{ROMAN[index + 1] ?? String(index + 1)}</b>
          <span>
            {item.title ? <strong style={{ display: "block", color: dark ? "#fff" : "var(--ink)" }}>{item.title}</strong> : null}
            {item.details.length ? (
              <ul style={{ margin: item.title ? "4px 0 0" : 0, paddingLeft: 16, fontSize: 13.5, lineHeight: 1.45 }}>
                {item.details.map((detail, detailIndex) => (
                  <li key={detailIndex} className={detail.startsWith("  · ") ? "rule" : undefined}>{detail.replace(/^ {2}· /, "")}</li>
                ))}
              </ul>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Remaining and total veto-window seconds, from the timestamps the vault reports. */
function vetoWindow(activatesAt: string, queuedAt: string, now: number): { remaining: number; total: number } {
  const total = Math.max(1, Math.round((Date.parse(activatesAt) - Date.parse(queuedAt)) / 1000));
  return { remaining: Math.max(0, Math.min(total, Math.round((Date.parse(activatesAt) - now) / 1000))), total };
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
  // Shareholders vote with their locked shares on company calls and transfers.
  const shares = useQuery({ queryKey: ["omni-shares"], queryFn: omni.shares, enabled: Boolean(data?.dao.shareholders), staleTime: 15_000 });
  const myShareVotes = shares.data?.deployed ? BigInt(shares.data.me?.votes ?? "0") : 0n;
  const lockedShares = data?.dao.shareholders ? BigInt(data.dao.shareholders.lockedShares) : 0n;

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
    <div className="page" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ font: "600 12px var(--font-ui)", color: "var(--ink-3)" }}>The assembly</span>
          <PageTitle>Votes</PageTitle>
          <span style={{ fontSize: 14, color: "var(--ink-2)", maxWidth: 720 }}>
            Members vote on every rule. An approved rule waits through a veto window, where any council member can stop it,
            then applies automatically. Agents never change rules.
          </span>
        </div>
        {data ? (
          <span style={{ marginLeft: "auto", padding: "8px 14px", border: "1px solid rgba(13,23,48,.2)", background: "rgba(255,255,255,.6)", fontSize: 12.5, whiteSpace: "nowrap" }}>
            {thresholdText(data.dao.threshold, data.dao.members.length)} approvals · {data.dao.members.length} members
          </span>
        ) : null}
      </header>
      {error ? <div className="alert error">{error}</div> : null}
      {notice ? <div className="alert success">{notice}</div> : null}
      {!me ? <div className="notice">Connect your NEAR wallet (top right) to vote or veto.</div> : null}
      {me && data && !isMember ? <div className="notice">{displayAccount(me)} is not a member of this company's DAO: you can read decisions but not vote.</div> : null}

      {data?.paused ? (
        <div style={{ border: "1px solid rgba(217,87,59,.5)", background: "rgba(217,87,59,.07)", padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "#6E2A1A" }}><strong>Operations are paused.</strong> Agents cannot move funds until members vote to resume.</span>
          <button
            className="btn-danger"
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

      <PageState loading={query.isLoading} error={query.error}>
        <div className="g2" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.22fr) minmax(0, .78fr)", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            <Kicker>Before the assembly · {open.length} proposal{open.length === 1 ? "" : "s"} waiting</Kicker>
            {open.length === 0 ? (
              <Slab style={{ padding: "16px 22px" }}>
                <div className="empty-state">No proposal is waiting for votes.</div>
              </Slab>
            ) : open.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                vaultAccountId={data!.vaultAccountId}
                needed={needed}
                me={me}
                canVote={(isMember || (myShareVotes > 0n && shareholderKind(proposal.kind))) && !(me in proposal.votes)}
                lockedShares={data?.dao.shareholders && shareholderKind(proposal.kind) ? lockedShares : null}
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

            <section style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 14 }}>
              <Kicker>How a proposal becomes law</Kicker>
              <div className="g4" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 0, position: "relative" }}>
                <div className="mline" aria-hidden="true" style={{ position: "absolute", left: "12%", right: "12%", top: 27, height: 2, background: "linear-gradient(90deg, #C9890C, #B4532E)" }} />
                {[
                  { numeral: "I", title: "PROPOSED", text: "A member writes the exact change, or turns a refused request into a vote" },
                  { numeral: "II", title: "VOTED", text: "Members approve, each checking the content in their own browser" },
                  { numeral: "III", title: "VETO WINDOW", text: "Any council member can still stop it" },
                  { numeral: "IV", title: "APPLIED", text: "The vault applies it; agents never change rules" },
                ].map((step) => (
                  <div key={step.numeral} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center", position: "relative" }}>
                    <Seal word={step.numeral} size={56} />
                    <b style={{ font: "700 12px var(--font-brand)", letterSpacing: ".14em" }}>{step.title}</b>
                    <span style={{ fontSize: 12.5, color: "var(--ink-2)", maxWidth: 170 }}>{step.text}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            <NightPanel style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
              <Kicker color="var(--gold)">Approved · veto window · {groups.length + scheduled.length}</Kicker>
              {groups.length + scheduled.length === 0 ? (
                <span style={{ fontSize: 13, color: "var(--night-text)" }}>No approved decision is waiting.</span>
              ) : (
                <>
                  {scheduled.map((transaction) => {
                    const win = vetoWindow(transaction.executesAt ?? new Date(now).toISOString(), transaction.createdAt, now);
                    return (
                      <div key={transaction.opId} style={{ display: "grid", gridTemplateColumns: "104px minmax(0, 1fr)", gap: 16, alignItems: "center", borderTop: "1px solid var(--night-line)", paddingTop: 14 }}>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                          <VetoRing remaining={win.remaining} total={win.total} size={104} />
                          <span style={{ font: "600 10px var(--font-brand)", letterSpacing: ".16em", color: "var(--night-mute)" }}>TO VETO</span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
                          <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".18em", color: "var(--night-mute)" }}>
                            Transaction · {transaction.executesAt && Date.parse(transaction.executesAt) > now ? `signed ${relativeTime(transaction.executesAt, now)}` : "waiting for the wallet"}
                          </span>
                          <b style={{ font: "800 16px/1.3 var(--font-brand)", letterSpacing: ".04em", color: "#fff" }}>{transaction.title}</b>
                          <VoteLines dark items={[{ title: transaction.details[0] ?? "", details: transaction.details.slice(1) }]} />
                          <span style={{ fontSize: 12.5, color: "var(--night-mute)" }}>Any council member can stop it before it is signed.</span>
                          <button style={darkDanger} disabled={!isMember || Boolean(busy)} onClick={() => void run(`veto-${transaction.opId}`, async () => {
                            await signVaultCall(me, data!.vaultAccountId, "veto_operation", { op_id: hexToBytes(transaction.opId) });
                            return "Transaction vetoed: it will not be signed.";
                          })}>Veto</button>
                        </div>
                      </div>
                    );
                  })}
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
                </>
              )}
            </NightPanel>

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

            <Slab style={{ padding: "16px 18px", display: "flex", flexDirection: "column" }}>
              <Kicker style={{ marginBottom: 4 }}>History</Kicker>
              {closed.length === 0 && settled.length === 0 ? <div className="empty-state">No past decision.</div> : (
                <>
                  {closed.map((proposal) => (
                    <div key={`p-${proposal.id}`} style={{ display: "grid", gridTemplateColumns: "40px minmax(0, 1fr)", gap: 12, alignItems: "center", padding: "8px 0", borderTop: "1px solid rgba(13,23,48,.1)" }}>
                      {/* A passed vote queues its rule changes: they apply after the veto window, listed below. */}
                      {proposal.status === "Approved" ? <Seal word="VOTED" size={36} /> : <Seal word={proposal.status.toUpperCase()} size={36} tone="refused" />}
                      <div style={{ fontSize: 13, minWidth: 0 }}>
                        <b>#{proposal.id} {proposal.title}</b>
                        <br /><small style={{ color: "var(--ink-3)" }}>{proposal.status} · {new Date(proposal.submittedAt).toLocaleString()}</small>
                      </div>
                    </div>
                  ))}
                  {settled.map((rule) => (
                    <div key={`r-${rule.queueId}`} style={{ display: "grid", gridTemplateColumns: "40px minmax(0, 1fr)", gap: 12, alignItems: "center", padding: "8px 0", borderTop: "1px solid rgba(13,23,48,.1)" }}>
                      {rule.state === "Executed" ? <Seal word="APPLIED" size={36} /> : rule.state === "Vetoed" ? <Seal word="VETOED" size={36} tone="refused" /> : rule.state === "Expired" ? <Seal word="EXPIRED" size={36} tone="expired" /> : <Seal word={rule.state.toUpperCase()} size={36} />}
                      <div style={{ fontSize: 13, minWidth: 0 }}>
                        <b>{rule.title}</b>
                        <br /><small style={{ color: "var(--ink-3)" }}>{rule.state}{rule.vetoedBy ? ` by ${displayAccount(rule.vetoedBy)}` : ""} · {new Date(rule.queuedAt).toLocaleString()}</small>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </Slab>

            <div style={{ padding: "14px 16px", border: "1px solid rgba(217,87,59,.45)", background: "rgba(217,87,59,.07)", display: "flex", gap: 14, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: "#6E2A1A" }}>
                <b>Emergency.</b> Any council member can pause all agent operations immediately. Resuming needs a members' vote.
              </span>
              <button
                className="btn-danger"
                style={{ whiteSpace: "nowrap" }}
                disabled={!isMember || Boolean(busy) || data?.paused}
                onClick={() => void run("pause", async () => {
                  await signVaultCall(me, data!.vaultAccountId, "pause", {});
                  return "Operations paused.";
                })}
              >
                Pause all operations
              </button>
            </div>
          </div>
        </div>
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
 * Supplier names come from Euthyna: the full address is printed next to each one.
 */
function useVerifiedChanges(proposal: GovernanceProposal, vaultAccountId: string): Sentence[] | null {
  const registry = useQuery({ queryKey: ["registry"], queryFn: () => api<Registry>("/v1/console/registry"), staleTime: 60_000 });
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status, staleTime: 60_000 });
  const directory = useQuery({ queryKey: ["omni-directory"], queryFn: omni.directory, staleTime: 60_000 });
  const policyChange = describePolicyChange(proposal.kind);
  if (policyChange) return [{ title: policyChange.title, details: policyChange.details }];
  const sharesChange = describeSharesProposal(proposal.kind, vaultAccountId.replace(/-vault\./, "-shares."));
  if (sharesChange) return [sharesChange];
  const listing = describeRegistryProposal(proposal.kind, directory.data?.registryId ?? null);
  if (listing) return [listing];
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
  const shares = vaultAccountId.replace(/-vault\./, "-shares.");
  labels[stringHash(nearRecipient(shares))] = `${nearRecipient(shares)} (company shares)`;
  const changes = calls.flatMap((call) => (call.method === "queue_rule_change" ? [call.change as RuleChange] : []));
  const context = { profile: BASE_SEPOLIA, labels, budgets: budgetsOf(changes, BASE_SEPOLIA), fullAddresses: true };
  return calls.map((call) => describeVaultCall(call, context));
}

/** Sputnik labels: shareholders vote on FunctionCall ("call") and Transfer ("transfer") proposals. */
function shareholderKind(kind: unknown): boolean {
  return typeof kind === "object" && kind !== null && ("FunctionCall" in kind || "Transfer" in kind);
}

function ProposalCard(props: {
  proposal: GovernanceProposal;
  vaultAccountId: string;
  needed: number;
  lockedShares?: bigint | null;
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
    <Slab as="article" style={{ padding: "16px 22px", display: "flex", flexDirection: "column", gap: 10 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <Kicker>Proposal #{proposal.id} · by {displayAccount(proposal.proposer)}</Kicker>
          <h3 style={{ margin: 0, font: "800 21px/1.25 var(--font-brand)", letterSpacing: ".04em" }}>{singleRoleTitle(proposal.changes) ?? proposal.title}</h3>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flex: "0 0 auto" }}>
          <VoteTokens votes={approvals} total={props.needed} />
          <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
            <b className="mono" style={{ color: "var(--ink)" }}>{approvals} / {props.needed}</b> approvals{rejections ? ` · ${rejections} against` : ""}
          </span>
          {props.lockedShares !== null && props.lockedShares !== undefined ? (
            <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
              or shareholders: {proposal.voteCounts?.shareholders?.[0] ?? "0"} / {(props.lockedShares / 2n + 1n).toString()} locked shares
            </span>
          ) : null}
        </div>
      </header>
      {verified ? (
        <>
          <VoteLines items={verified} />
          <p className="verified" style={{ fontSize: 12.5, margin: 0 }}>✓ Read in your browser from the proposal stored in the DAO. Your vote is only valid for exactly this content.</p>
        </>
      ) : (
        <div className="alert error" style={{ margin: 0 }}>
          This proposal does not change this company's vault. Read it carefully before voting.
          <VoteLines items={proposal.changes} />
        </div>
      )}
      <footer style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>Expires {relativeTime(proposal.expiresAt, props.now)}</span>
        <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
          {Object.entries(proposal.votes).map(([voter, vote]) => `${displayAccount(voter)}: ${vote}`).join(" · ") || "No vote yet"}
        </span>
        <div className="spacer" />
        {proposal.votes[props.me] ? <span style={{ fontSize: 12.5, color: "var(--ink)", fontWeight: 700 }}>You voted {proposal.votes[props.me]}</span> : null}
        <button className="btn-line" disabled={!props.canVote || Boolean(props.busy)} onClick={() => props.onVote("VoteReject")}>Reject</button>
        <button className="btn-ori" disabled={!props.canVote || Boolean(props.busy)} onClick={() => props.onVote("VoteApprove")}>
          {props.busy === `vote-${proposal.id}` ? "Signing…" : "APPROVE"}
        </button>
      </footer>
    </Slab>
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
  const win = vetoWindow(first.activatesAt, first.queuedAt, props.now);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "104px minmax(0, 1fr)", gap: 16, alignItems: "center", borderTop: "1px solid var(--night-line)", paddingTop: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
        <VetoRing remaining={ready ? 0 : win.remaining} total={win.total} size={104} />
        <span style={{ font: "600 10px var(--font-brand)", letterSpacing: ".16em", color: "var(--night-mute)" }}>{ready ? "READY" : "TO VETO"}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".18em", color: "var(--night-mute)" }}>
          Approved · {ready ? "veto window over" : `applies ${relativeTime(first.activatesAt, props.now)}`}
        </span>
        <b style={{ font: "800 16px/1.3 var(--font-brand)", letterSpacing: ".04em", color: "#fff" }}>
          {singleRoleTitle(props.rules) ?? (props.rules.length === 1 ? first.title : `${props.rules.length} changes approved together`)}
        </b>
        <VoteLines dark items={props.rules.map((rule) => ({ title: rule.title, details: rule.details }))} />
        <span style={{ fontSize: 12.5, color: "var(--night-mute)" }}>Applies at {new Date(first.activatesAt).toLocaleTimeString()} unless a council member vetoes it.</span>
        {ready ? (
          <button className="btn-ori" style={{ alignSelf: "flex-start" }} disabled={Boolean(props.busy)} onClick={props.onActivate}>Apply now</button>
        ) : (
          <button style={darkDanger} disabled={!props.canVeto || Boolean(props.busy)} onClick={props.onVeto}>
            {props.busy === `veto-${first.queueId}` ? "Signing…" : "VETO"}
          </button>
        )}
      </div>
    </div>
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
    <Slab style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHead
        left={<Kicker>Members · {props.members.length}</Kicker>}
        right={<span style={{ font: "700 11px var(--font-brand)", letterSpacing: ".16em", color: "var(--ink-2)" }}>{councilThreshold(list.length)} of {list.length} approvals</span>}
      />
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-2)" }}>
        The NEAR accounts that vote, veto and pause. Changing them is itself a decision: the DAO members apply when approved,
        the security council after the veto window.
      </p>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {list.map((member) => (
          <div key={member} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: "1px solid rgba(13,23,48,.1)", fontSize: 13 }}>
            <span style={{ width: 26, height: 26, borderRadius: "50%", background: member === props.me ? "var(--gold)" : "var(--vein)", color: "var(--ink)", display: "flex", alignItems: "center", justifyContent: "center", font: "800 11px var(--font-ui)", flex: "0 0 auto" }}>
              {member.slice(0, 1).toUpperCase()}
            </span>
            <span className="mono" style={{ fontSize: 12.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              <span title={member}>{displayAccount(member)}</span>
              {member === props.me ? <span style={{ color: "var(--ink-3)", fontFamily: "var(--font-ui)" }}> (you)</span> : null}
              {!props.members.includes(member) ? <span style={{ color: "var(--terra-ink)", fontFamily: "var(--font-ui)" }}> · to add</span> : null}
            </span>
            <button
              className="btn-line"
              style={{ marginLeft: "auto", padding: "5px 10px", fontSize: 10 }}
              disabled={!props.canPropose || list.length <= 3}
              title={list.length <= 3 ? "At least three members" : undefined}
              onClick={() => setNext(list.filter((item) => item !== member))}
            >Remove</button>
          </div>
        ))}
        {props.members.filter((member) => !list.includes(member)).map((member) => (
          <div key={member} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: "1px solid rgba(13,23,48,.1)", fontSize: 12.5, color: "var(--ink-3)" }}>
            <span className="mono"><s title={member}>{displayAccount(member)}</s> · to remove</span>
          </div>
        ))}
      </div>
      <form style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={(event) => {
        event.preventDefault();
        const value = account.trim().toLowerCase();
        if (value && !list.includes(value)) setNext([...list, value]);
        setAccount("");
      }}>
        <div className="field-app" style={{ flex: "1 1 190px" }}>
          <label>New member</label>
          <input placeholder="new-member.testnet" value={account} onChange={(event) => setAccount(event.target.value)} />
        </div>
        <button className="btn-line" style={{ padding: "11px 16px" }} type="submit" disabled={!props.canPropose || account.trim().length < 2}>Add</button>
        {changed ? (
          <>
            <div className="spacer" />
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{list.length} members · {councilThreshold(list.length)} of {list.length} approvals</span>
            <button className="btn-line" type="button" onClick={() => setNext(null)}>Undo</button>
            <button className="btn-ori" type="button" disabled={!props.canPropose} onClick={() => { props.onPropose(list); setNext(null); }}>Propose this change</button>
          </>
        ) : null}
      </form>
    </Slab>
  );
}
