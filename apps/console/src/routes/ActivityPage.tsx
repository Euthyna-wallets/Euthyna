import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { api, type AgentRow } from "../api.js";
import { Icon } from "../components/ops.js";
import { PageState, Status, short } from "../components/ui.js";
import { OUTCOME_LABEL, dayLabel, entriesOf, roleName, timeOf, type Entry } from "../lib/money.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type ProposalDraft, type Sentence, type WalletIntegrity } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";
import { SentenceList } from "./GovernancePage.js";
import { verifyTransactions, type Requested } from "./WalletPage.js";

const EXPLORERS: Record<number, string> = { 84532: "https://sepolia.basescan.org", 11155111: "https://sepolia.etherscan.io", 8453: "https://basescan.org", 1: "https://etherscan.io" };
const NEAR_EXPLORER = "https://testnet.nearblocks.io";

type Filter = "all" | "done" | "pending" | "refused";

const FILTERS: Array<[Filter, string]> = [["all", "All"], ["done", "Done"], ["pending", "In progress"], ["refused", "Refused"]];

export function ActivityPage() {
  const query = useQuery({ queryKey: ["omni-activity"], queryFn: omni.activity, refetchInterval: 10_000 });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ agents: AgentRow[] }>("/v1/console/agents"), staleTime: 30_000 });
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const all = entriesOf(query.data);
  const count = (value: Filter) => value === "all" ? all.length : all.filter((entry) => matches(entry, value)).length;
  const shown = all.filter((entry) => matches(entry, filter));
  const nameOf = (actor: string) => (agents.data?.agents ?? []).find((agent) => agent.nearAccountId === actor || agent.name === actor)?.name ?? short(actor, 18);
  const groups: Array<[string, Entry[]]> = [];
  for (const entry of shown) {
    const label = dayLabel(entry.at);
    const group = groups.find(([name]) => name === label);
    if (group) group[1].push(entry);
    else groups.push([label, [entry]]);
  }
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="muted">Every payment, swap and deposit made with company money, and every request the rules refused.</p>
        </div>
      </header>

      <Trust items={query.data?.integrity ?? []} />

      <div className="filters" role="tablist" aria-label="Filter activity">
        {FILTERS.map(([value, label]) => (
          <button key={value} role="tab" aria-selected={filter === value} className={`filter${filter === value ? " active" : ""}`} onClick={() => setFilter(value)}>
            {label} <span>{count(value)}</span>
          </button>
        ))}
      </div>

      <PageState loading={query.isLoading} error={query.error} empty={shown.length === 0} emptyContent={<div className="state">Nothing here yet.</div>}>
        {groups.map(([label, entries]) => (
          <section key={label} className="panel day">
            <h2 className="day-label">{label}</h2>
            <ul className="tx-list">
              {entries.map((entry) => (
                <li key={entry.id} className={open === entry.id ? "open" : undefined}>
                  <button className="tx-row" aria-expanded={open === entry.id} onClick={() => setOpen(open === entry.id ? null : entry.id)}>
                    <span className={`tx-icon ${entry.outcome}`}><Icon name={entry.outcome === "refused" || entry.outcome === "failed" ? "cross" : entry.outcome === "pending" ? "setup" : "check"} size={15} /></span>
                    <span className="tx-text">
                      <strong>{entry.text}</strong>
                      <span>{nameOf(entry.actor)}{entry.role ? ` · ${roleName(entry.role)}` : entry.operation ? " · voted by members" : ""}{entry.chain ? ` · ${entry.chain}` : ""} · {timeOf(entry.at)}</span>
                      {entry.outcome === "refused" && entry.reason ? <span className="tx-reason">Refused: {humanReason(entry.reason)}</span> : null}
                    </span>
                    <span className={`outcome outcome-${entry.outcome}`}>{OUTCOME_LABEL[entry.outcome]}</span>
                  </button>
                  {open === entry.id ? <Proof entry={entry} actor={nameOf(entry.actor)} /> : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </PageState>
    </div>
  );
}

function matches(entry: Entry, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "refused") return entry.outcome === "refused" || entry.outcome === "failed" || entry.outcome === "cancelled";
  return entry.outcome === filter;
}

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
function Proof({ entry, actor }: { entry: Entry; actor: string }) {
  const operation = entry.operation;
  const rows: Array<[string, ReactNode]> = [["Requested by", <span className="mono">{entry.actor}</span>]];
  if (!operation) {
    rows.push(["Recorded by", "Euthyna: a refused request never becomes a transaction"]);
    if (entry.reason) rows.push(["Vault answer", <span className="mono">{entry.reason}</span>]);
  } else {
    rows.push(["Vault status", <Status value={operation.vaultState} />]);
    if (operation.nearAuthorizationTxHash) rows.push(["Signed on NEAR", <a href={`${NEAR_EXPLORER}/txns/${operation.nearAuthorizationTxHash}`} target="_blank" rel="noreferrer">{short(operation.nearAuthorizationTxHash)} ↗</a>]);
    if (operation.evm) rows.push([`${operation.chain} transaction`, <a href={`${EXPLORERS[operation.chainId] ?? ""}/tx/${operation.evm.hash}`} target="_blank" rel="noreferrer">{short(operation.evm.hash)} ↗</a>]);
    if (operation.solana) rows.push([`${operation.chain} transaction`, <a href={operation.solana.explorer} target="_blank" rel="noreferrer">{short(operation.solana.signature)} ↗</a>]);
    if (operation.near) rows.push(["Token transfer", operation.vaultState === "Confirmed" ? "ft_transfer succeeded, budget spent" : operation.vaultState === "Failed" ? "ft_transfer failed, budget released" : operation.vaultState === "Unconfirmed" ? "No result came back: budget kept spent, check the transaction" : "Waiting for the token's answer"]);
    if (operation.solana) rows.push(["Finality", operation.vaultState === "Confirmed" ? "Attested by NEAR's MPC network" : "Waiting"]);
    if (operation.nonce !== null) rows.push(["Wallet nonce", <span className="mono">{operation.nonce}</span>]);
    if (operation.reference) rows.push(["Reference", <span className="mono">{operation.reference}</span>]);
    rows.push(["Operation id", <span className="mono">{short(operation.opId, 18)}</span>]);
  }
  return (
    <div className="proof">
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {entry.request ? <AskMembers request={entry.request} title={`${actor}: ${entry.text}`} /> : null}
    </div>
  );
}

/** One line: did anything leave the wallets outside the vault? (nonce on chain = nonce signed by the vault) */
function Trust({ items }: { items: WalletIntegrity[] }) {
  if (items.length === 0) return null;
  const alert = items.find((item) => item.status === "alert");
  if (alert) {
    return (
      <div className="trust bad">
        <Icon name="cross" size={16} />
        <span><strong>Check {alert.chain} now.</strong> The wallet sent {alert.walletNonce} transactions, the vault signed {alert.vaultNonce}. Something left {short(alert.address)} without the vault.</span>
      </div>
    );
  }
  const pending = items.filter((item) => item.status === "pending");
  return (
    <div className="trust ok">
      <Icon name="check" size={16} />
      <span>
        <strong>Every transaction went through the vault.</strong> The wallets sent exactly what the vault signed.
        {pending.length ? ` ${pending.map((item) => `${item.vaultNonce - (item.walletNonce ?? 0)} on ${item.chain}`).join(", ")} still being mined.` : ""}
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
