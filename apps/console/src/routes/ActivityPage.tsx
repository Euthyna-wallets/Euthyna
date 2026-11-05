import { useQuery } from "@tanstack/react-query";
import { cardAccountIdOf } from "@euthyna/sdk/roles";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { api, type AgentRow } from "../api.js";
import { Seal, Slab, PageTitle } from "../components/design.js";
import { Icon } from "../components/ops.js";
import { PageState, short } from "../components/ui.js";
import { marketConsole } from "../lib/market.js";
import { OUTCOME_LABEL, dayLabel, entriesOf, marketEntriesOf, roleName, timeOf, type Entry, type Outcome } from "../lib/money.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type ProposalDraft, type Sentence, type WalletIntegrity } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";
import { SentenceList } from "./GovernancePage.js";
import { verifyTransactions, type Requested } from "./WalletPage.js";

const EXPLORERS: Record<number, string> = { 84532: "https://sepolia.basescan.org", 11155111: "https://sepolia.etherscan.io", 8453: "https://basescan.org", 1: "https://etherscan.io" };
const NEAR_EXPLORER = "https://testnet.nearblocks.io";

type Filter = "all" | "done" | "pending" | "refused";

const FILTERS: Array<[Filter, string]> = [["all", "All"], ["done", "Done"], ["pending", "In progress"], ["refused", "Refused"]];

/** The evidence block: a pale plate under the row, aligned with its text column. */
const PROOF_BOX: CSSProperties = { margin: "0 20px 14px 84px", padding: "14px 18px", background: "rgba(6,20,51,.04)", borderLeft: "2px solid var(--gold-deep)", fontSize: 12.5 };
const PROOF_GRID: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "10px 26px", margin: 0 };
const PROOF_DT: CSSProperties = { color: "var(--ink-3)", fontSize: 11.5 };
const PROOF_DD: CSSProperties = { margin: "2px 0 0", color: "var(--ink)", fontWeight: 600, overflowWrap: "anywhere" };
const PROOF_LINK: CSSProperties = { color: "var(--aegean-ink)", fontFamily: "var(--font-mono)" };
const MONO: CSSProperties = { fontFamily: "var(--font-mono)" };

export function ActivityPage() {
  const query = useQuery({ queryKey: ["omni-activity"], queryFn: omni.activity, refetchInterval: 10_000 });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ agents: AgentRow[] }>("/v1/console/agents"), staleTime: 30_000 });
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  // Market rows are optional: a company that never sold or bought just has none.
  const sales = useQuery({ queryKey: ["market-sales"], queryFn: marketConsole.sales, retry: false, refetchInterval: 15_000 });
  const purchases = useQuery({ queryKey: ["market-purchases"], queryFn: marketConsole.purchases, retry: false, refetchInterval: 15_000 });
  const all = [...entriesOf(query.data), ...marketEntriesOf(sales.data?.sales, purchases.data?.purchases)].sort((a, b) => b.at.localeCompare(a.at));
  const count = (value: Filter) => value === "all" ? all.length : all.filter((entry) => matches(entry, value)).length;
  const shown = all.filter((entry) => matches(entry, filter));
  const cardOf = (account: string) => { try { return cardAccountIdOf(account); } catch { return null; } };
  const nameOf = (actor: string) => {
    const agent = (agents.data?.agents ?? []).find((item) => item.nearAccountId === actor || item.name === actor || cardOf(item.nearAccountId) === actor);
    if (!agent) return short(actor, 18);
    return agent.nearAccountId === actor || agent.name === actor ? agent.name : `${agent.name}'s card`;
  };
  const groups: Array<[string, Entry[]]> = [];
  for (const entry of shown) {
    const label = dayLabel(entry.at);
    const group = groups.find(([name]) => name === label);
    if (group) group[1].push(entry);
    else groups.push([label, [entry]]);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 6, margin: 0 }}>
        <span style={{ font: "600 12px var(--font-ui)", color: "var(--ink-3)" }}>The record</span>
        <PageTitle style={{ font: "900 40px/1 var(--font-brand)", letterSpacing: ".12em" }}>Activity</PageTitle>
        <p style={{ margin: 0, fontSize: 14, color: "var(--ink-2)", maxWidth: 760 }}>Every payment, swap and deposit made with company money, every market sale and purchase, and every request the rules refused.</p>
      </header>

      <Trust items={query.data?.integrity ?? []} />

      <div className="tab-line" role="tablist" aria-label="Filter activity">
        {FILTERS.map(([value, label]) => (
          <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? "on" : undefined}
            style={{ borderRadius: 2, padding: "8px 14px", font: "600 13px var(--font-ui)", background: filter === value ? "var(--ink)" : "rgba(255,255,255,.55)", border: `1px solid ${filter === value ? "var(--ink)" : "rgba(13,23,48,.14)"}`, color: filter === value ? "var(--marble)" : "var(--ink-2)" }}
            onClick={() => setFilter(value)}>
            {label} <span style={{ marginLeft: 6, font: "600 11px var(--font-mono)", color: filter === value ? "var(--night-soft)" : "var(--ink-3)" }}>{count(value)}</span>
          </button>
        ))}
      </div>

      <PageState loading={query.isLoading} error={query.error} empty={shown.length === 0} emptyContent={<Slab style={{ padding: "20px 22px" }}><span className="empty-state">Nothing here yet.</span></Slab>}>
        <Slab style={{ paddingBottom: 4 }}>
          {groups.map(([label, entries], index) => (
            <div key={label} style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ font: "700 11px var(--font-brand)", letterSpacing: ".24em", color: "var(--gold-ink)", padding: "12px 20px 8px", borderTop: index === 0 ? "none" : "1px solid rgba(13,23,48,.1)", marginTop: index === 0 ? 0 : 4 }}>{label}</div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {entries.map((entry) => {
                  const seal = sealOf(entry);
                  const translated = entry.reason ? humanReason(entry.reason) !== entry.reason : false;
                  return (
                    <li key={entry.id} style={{ borderTop: "1px solid rgba(13,23,48,.1)" }}>
                      <button aria-expanded={open === entry.id} onClick={() => setOpen(open === entry.id ? null : entry.id)}
                        style={{ display: "grid", gridTemplateColumns: "48px minmax(0,1fr) auto", gap: 16, alignItems: "center", width: "100%", padding: "10px 20px", border: 0, background: "none", textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer" }}>
                        <Seal word={seal.word} size={44} {...(seal.tone ? { tone: seal.tone } : {})} />
                        <span style={{ minWidth: 0 }}>
                          <b style={{ fontSize: 14.5 }}>{entry.text}</b>
                          <span style={{ display: "block", fontSize: 12.5, color: "var(--ink-3)", marginTop: 2 }}>
                            {nameOf(entry.actor)}{entry.market ? (entry.market.kind === "sale" ? " · market sale" : " · market purchase") : entry.role ? ` · ${roleName(entry.role)}` : entry.operation ? " · voted by members" : ""}{entry.chain ? ` · ${entry.chain}` : ""} · {timeOf(entry.at)}
                          </span>
                          {entry.outcome === "refused" && entry.reason ? (
                            <span style={{ display: "block", fontSize: 12.5, color: "var(--terra-ink)", marginTop: 5 }}>
                              Refused: {humanReason(entry.reason)}
                              {translated ? <> · <code className="mono" style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-2)" }}>{entry.reason}</code></> : null}
                            </span>
                          ) : null}
                        </span>
                        <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".16em", textAlign: "right", color: OUTCOME_COLOR[entry.outcome] }}>{OUTCOME_LABEL[entry.outcome].toUpperCase()}</span>
                      </button>
                      {entry.request ? (
                        <div style={{ padding: "0 20px 10px 84px" }}>
                          <AskMembers request={entry.request} title={`${nameOf(entry.actor)}: ${entry.text}`} />
                        </div>
                      ) : null}
                      {open === entry.id ? (entry.market ? <MarketProof entry={entry} /> : <Proof entry={entry} />) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </Slab>
      </PageState>
    </div>
  );
}

function matches(entry: Entry, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "refused") return entry.outcome === "refused" || entry.outcome === "failed" || entry.outcome === "cancelled";
  return entry.outcome === filter;
}

/** The inked word on the seal: what the vault answered, or where the market's money is. */
function sealOf(entry: Entry): { word: string; tone?: "refused" | "expired" } {
  if (entry.market) {
    const { sale } = entry.market;
    if (sale.holdState === "settled" || sale.holdState === "prepaid") return { word: "SETTLED" };
    if (sale.holdState === "held") return { word: "HELD" };
    if (sale.holdState === "settling") return { word: "SETTLING" };
    if (sale.holdState === "expired" || sale.state === "expired") return { word: "EXPIRED", tone: "expired" };
    if (sale.holdState === "failed" || sale.state === "failed") return { word: "FAILED", tone: "refused" };
    return { word: "PENDING" };
  }
  const state = entry.operation?.vaultState;
  if (entry.outcome === "refused") return { word: "REFUSED", tone: "refused" };
  if (state === "Vetoed") return { word: "VETOED", tone: "expired" };
  if (state === "Expired" || state === "Cancelled") return { word: "EXPIRED", tone: "expired" };
  if (entry.outcome === "failed" || state === "Failed") return { word: "FAILED", tone: "refused" };
  if (entry.outcome === "done") return { word: "SIGNED" };
  return { word: "PENDING" };
}

/** The word at the right of the row, in the colour of its meaning. */
const OUTCOME_COLOR: Record<Outcome, string> = {
  done: "var(--aegean-ink)",
  pending: "var(--gold-ink)",
  failed: "var(--terra-ink)",
  refused: "var(--terra-ink)",
  cancelled: "var(--ink-3)",
};

/** Vault error codes, in words. */
function humanReason(reason: string): string {
  const known: Record<string, string> = {
    FunctionNotAllowed: "this action or recipient is not in the agent's rules",
    allowanceExceeded: "over the agent's budget",
    ERR_ROLE_NOT_FOUND: "the agent has no rule yet",
    ERR_PAUSED: "operations are paused",
  };
  const code = Object.keys(known).find((key) => reason.includes(key));
  return code ? known[code]! : reason;
}

/** The evidence, for whoever wants to check: vault record on NEAR, transaction on the destination chain. */
function Proof({ entry }: { entry: Entry }) {
  const operation = entry.operation;
  const rows: Array<[string, ReactNode]> = [["Requested by", <span className="mono" style={MONO}>{entry.actor}</span>]];
  if (!operation) {
    rows.push(["Recorded by", "Euthyna: a refused request never becomes a transaction"]);
    if (entry.reason) rows.push(["Vault answer", <span className="mono" style={MONO}>{entry.reason}</span>]);
  } else {
    rows.push(["Vault status", operation.vaultState]);
    if (operation.nearAuthorizationTxHash) rows.push(["Signed on NEAR", <a className="mono" style={PROOF_LINK} href={`${NEAR_EXPLORER}/txns/${operation.nearAuthorizationTxHash}`} target="_blank" rel="noreferrer">{short(operation.nearAuthorizationTxHash)} ↗</a>]);
    if (operation.evm) rows.push([`${operation.chain} transaction`, <a className="mono" style={PROOF_LINK} href={`${EXPLORERS[operation.chainId] ?? ""}/tx/${operation.evm.hash}`} target="_blank" rel="noreferrer">{short(operation.evm.hash)} ↗</a>]);
    if (operation.solana) rows.push([`${operation.chain} transaction`, <a className="mono" style={PROOF_LINK} href={operation.solana.explorer} target="_blank" rel="noreferrer">{short(operation.solana.signature)} ↗</a>]);
    if (operation.near) rows.push(["Token transfer", operation.vaultState === "Confirmed" ? "ft_transfer succeeded, budget spent" : operation.vaultState === "Failed" ? "ft_transfer failed, budget released" : operation.vaultState === "Unconfirmed" ? "No result came back: budget kept spent, check the transaction" : "Waiting for the token's answer"]);
    if (operation.solana) rows.push(["Finality", operation.vaultState === "Confirmed" ? "Attested by NEAR's MPC network" : "Waiting"]);
    if (operation.nonce !== null) rows.push(["Wallet nonce", <span className="mono" style={MONO}>{operation.nonce}</span>]);
    if (operation.reference) rows.push(["Reference", <span className="mono" style={MONO}>{operation.reference}</span>]);
    rows.push(["Operation id", <span className="mono" style={MONO}>{short(operation.opId, 18)}</span>]);
  }
  return (
    <div style={PROOF_BOX}>
      <dl style={PROOF_GRID}>{rows.map(([label, value]) => <div key={label}><dt style={PROOF_DT}>{label}</dt><dd style={PROOF_DD}>{value}</dd></div>)}</dl>
    </div>
  );
}

const PAYMENT_TEXT: Record<string, string> = {
  held: "Buyer's signed cheque held by the market, paid on delivery",
  settling: "Delivered: the market is relaying the cheque",
  settled: "Paid on NEAR after delivery",
  prepaid: "Paid upfront from a browser wallet, checked on NEAR",
  failed: "The cheque could not be paid (balance or nonce changed)",
  expired: "Not delivered in time: the cheque was never relayed",
};

/** A market task: who, what, and where the money is. */
function MarketProof({ entry }: { entry: Entry }) {
  const { kind, sale } = entry.market!;
  const rows: Array<[string, ReactNode]> = [
    [kind === "sale" ? "Your listing" : "Seller's listing", <span className="mono" style={MONO}>@{sale.handle}</span>],
    ["Buyer", <span className="mono" style={MONO}>{sale.buyer}</span>],
    ["Task", sale.state === "completed_unpaid" ? "Delivered, not paid" : sale.state.charAt(0).toUpperCase() + sale.state.slice(1)],
    ["Payment", sale.holdState ? PAYMENT_TEXT[sale.holdState] ?? sale.holdState : "No payment held"],
  ];
  if (sale.settleTxHash) rows.push(["Paid on NEAR", <a className="mono" style={PROOF_LINK} href={`${NEAR_EXPLORER}/txns/${sale.settleTxHash}`} target="_blank" rel="noreferrer">{short(sale.settleTxHash)} ↗</a>]);
  rows.push(["Result", <Link style={PROOF_LINK} to={`/market/task/${sale.taskId}`}>Open the task</Link>]);
  return <div style={PROOF_BOX}><dl style={PROOF_GRID}>{rows.map(([label, value]) => <div key={label}><dt style={PROOF_DT}>{label}</dt><dd style={PROOF_DD}>{value}</dd></div>)}</dl></div>;
}

/** One line: did anything leave the wallets outside the vault? (nonce on chain = nonce signed by the vault) */
function Trust({ items }: { items: WalletIntegrity[] }) {
  if (items.length === 0) return null;
  const alert = items.find((item) => item.status === "alert");
  if (alert) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", padding: "12px 18px", background: "#FDECEB", border: "1px solid rgba(217,87,59,.45)" }}>
        <span style={{ color: "var(--terra-ink)", display: "inline-flex" }}><Icon name="cross" size={18} /></span>
        <span style={{ fontSize: 14, color: "var(--ink)" }}><strong>Check {alert.chain} now.</strong> The wallet sent {alert.walletNonce} transactions, the vault signed {alert.vaultNonce}. Something left {short(alert.address)} without the vault.</span>
        <span className="mono" style={{ marginLeft: "auto", fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--terra-ink)" }}>{alert.chain} · wallet {alert.walletNonce ?? "—"} · vault {alert.vaultNonce}</span>
      </div>
    );
  }
  const pending = items.filter((item) => item.status === "pending");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", padding: "12px 18px", background: "var(--aegean-bg)", border: "1px solid rgba(11,110,134,.3)" }}>
      <Seal word="INTACT" size={40} />
      <span style={{ fontSize: 14, color: "var(--ink)" }}>
        <strong>Every transaction went through the vault.</strong> The wallets sent exactly what the vault signed.
        {pending.length ? ` ${pending.map((item) => `${item.vaultNonce - (item.walletNonce ?? 0)} on ${item.chain}`).join(", ")} still being mined.` : ""}
      </span>
      <span className="mono" style={{ marginLeft: "auto", fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--aegean-ink)" }}>
        {items.map((item) => `${item.chain} · wallet ${item.walletNonce ?? "—"} · vault ${item.vaultNonce}`).join("  ·  ")}
      </span>
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
      <span style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
        <SentenceList items={state.preview.summary} />
        <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn-line" style={{ padding: "7px 12px", font: "700 10.5px var(--font-brand)", letterSpacing: ".16em" }} onClick={() => setState({ busy: false, message: null, preview: null })}>Cancel</button>
          <button className="btn-ori" style={{ padding: "8px 14px", font: "800 11px var(--font-brand)", letterSpacing: ".16em" }} disabled={state.busy} onClick={() => act(async () => {
            const result = await signDaoProposal(wallets.nearAccountId, state.preview!.draft);
            setState({ busy: false, message: `Proposal #${result.proposalId} submitted to the members.`, preview: null });
          })}>Submit to the members' vote</button>
        </span>
      </span>
    );
  }
  return (
    <span>
      <button className="btn-line" style={{ padding: "7px 12px", font: "700 10.5px var(--font-brand)", letterSpacing: ".16em" }} disabled={state.busy} onClick={() => act(async () => {
        const requested = [{ chainId: props.request.chainId, to: props.request.to, value: props.request.value, data: props.request.data }];
        const draft = await omni.transactionProposal({ title: props.title.slice(0, 120), transactions: requested });
        setState({ busy: false, message: null, preview: { draft, summary: verifyTransactions(draft, requested, treasury.daoAccountId, treasury.vaultAccountId) } });
      })}>Ask the members to vote on it</button>
      {state.message ? <span className="small" style={{ marginLeft: 8, color: "var(--ink-2)" }}>{state.message}</span> : null}
    </span>
  );
}
