import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { getAddress } from "viem";
import { isSolanaAddress, SOLANA_DEVNET } from "@mandateos/sdk/solana";
import { BASE_SEPOLIA, budgetsOf, compileRole, decodeVaultCalls, describeVaultCall, nearRecipient, stringHash, validRoleName, type LendingId, type ProtocolId, type RoleBlock, type RoleDraft } from "@mandateos/sdk/roles";

import { api, type AgentRow } from "../api.js";
import { Card, PageState, Status, everyDays, short } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type ProposalDraft, type RoleView } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";
import { summarizeRoleChanges, type RoleSummary } from "../lib/role-summary.js";
import { SentenceList } from "./GovernancePage.js";

type Registry = { suppliers: Array<{ id: string; name: string; wallets: Array<{ chainId: number; address: string }> }> };

const PROFILE = BASE_SEPOLIA;
const PROTOCOLS = Object.entries(PROFILE.protocols) as Array<[ProtocolId, { name: string; router: string }]>;

export function RolesPage() {
  const roles = useQuery({ queryKey: ["omni-roles"], queryFn: omni.roles, refetchInterval: 15_000 });
  const [params, setParams] = useSearchParams();
  const [building, setBuilding] = useState(params.get("new") === "1");
  const suggested = params.get("role") ?? "";
  const job = params.get("job");
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Rules</h1>
          <p className="muted">
            A role is what an agent may do with company funds: which contracts, which counterparties, which budget.
            Everything else is refused by the vault.
          </p>
        </div>
        {!building ? <button className="primary" onClick={() => setBuilding(true)}>New role</button> : null}
      </header>
      {building ? <RoleBuilder initialName={suggested} initialJob={job} onClose={() => { setBuilding(false); setParams({}); }} /> : null}
      <RolesInProgress />
      <PageState
        loading={roles.isLoading}
        error={roles.error}
        empty={roles.data?.roles.length === 0}
        emptyContent={building ? <></> : (
          <div className="state empty-action">
            <span>No active role yet. Create one, the members vote on it, and it applies after the veto window.</span>
            <button className="primary" onClick={() => setBuilding(true)}>Create the first role</button>
          </div>
        )}
      >
        {(roles.data?.roles ?? []).map((role) => <RoleCard key={role.name} role={role} />)}
      </PageState>
    </div>
  );
}

/**
 * A role exists only once voted and past the veto window. Until then, show
 * where it stands so it does not look lost.
 */
function RolesInProgress() {
  const governance = useQuery({ queryKey: ["omni-governance"], queryFn: omni.governance, refetchInterval: 15_000 });
  const data = governance.data;
  if (!data) return null;
  const needed = (() => {
    const threshold = data.dao.threshold as unknown;
    if (typeof threshold === "string" || typeof threshold === "number") return Number(threshold);
    if (threshold && typeof threshold === "object" && "Weight" in threshold) return Number((threshold as { Weight: string }).Weight);
    return null;
  })();
  // A vote on a role is several rule changes; fold each vote back into its role(s).
  const items: Array<{ key: string; status: string; roles: RoleSummary[] }> = [];
  for (const proposal of data.proposals.filter((item) => item.status === "InProgress")) {
    const { roles } = summarizeRoleChanges(proposal.changes);
    if (roles.length === 0) continue;
    const approvals = Object.values(proposal.votes).filter((vote) => vote === "Approve").length;
    items.push({ key: `p${proposal.id}`, status: `Waiting for votes: ${approvals}${needed ? ` of ${needed}` : ""} approvals`, roles });
  }
  const queued = new Map<string, typeof data.rules>();
  for (const rule of data.rules.filter((item) => item.state === "Queued")) {
    const key = `${rule.queuedAt}|${rule.activatesAt}`;
    queued.set(key, [...(queued.get(key) ?? []), rule]);
  }
  for (const [key, rules] of queued) {
    const { roles } = summarizeRoleChanges(rules);
    if (roles.length === 0) continue;
    const first = rules[0]!;
    const ready = rules.every((rule) => rule.readyToActivate);
    items.push({ key: `q${key}`, status: ready ? "Veto window over: applying now" : `Approved: active at ${new Date(first.activatesAt).toLocaleTimeString()} unless vetoed`, roles });
  }
  if (items.length === 0) return null;
  return (
    <Card title="On its way" action={<Link className="small" to="/governance">Open Decisions</Link>}>
      <div className="stack">
        {items.flatMap((item) => item.roles.map((role) => (
          <div key={`${item.key}-${role.role}`} className="role-progress">
            <div className="row wrap" style={{ justifyContent: "space-between" }}>
              <strong>Role "{role.role}"{role.deleted ? " · deleted" : role.disabled ? " · disabled" : ""}</strong>
              <span className="small muted">{item.status}</span>
            </div>
            {role.allows.length ? (
              <ul className="small role-progress-list">
                {role.allows.map((line, index) => <li key={index} className={line.startsWith("  ·") ? "sub" : undefined}>{line.replace(/^\s*·\s*/, "")}</li>)}
              </ul>
            ) : null}
            {role.budgets.length ? <div className="small">Budget: {role.budgets.join(" · ")}</div> : null}
            {role.holders.length ? <div className="small">Held by {role.holders.join(", ")}</div> : null}
            {role.removedHolders.length ? <div className="small">No longer held by {role.removedHolders.join(", ")}</div> : null}
          </div>
        )))}
      </div>
    </Card>
  );
}

function RoleCard({ role }: { role: RoleView }) {
  return (
    <Card title={`Role · ${role.name}`} action={<Status value={role.enabled ? "active" : "disabled"} />}>
      <div className="role-grid">
        <div>
          <h3>Budgets</h3>
          {role.budgets.length === 0 ? <p className="muted small">No budget: this role cannot move value.</p> : role.budgets.map((budget) => {
            const available = Number(budget.available ?? 0);
            const max = Number(budget.max ?? 0);
            const left = max > 0 ? Math.max(0, Math.min(100, Math.round((available / max) * 100))) : 0;
            return (
              <div key={budget.key} className="budget">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span>{budget.label}</span>
                  <span className="small">{available.toLocaleString()} / {max.toLocaleString()} {budget.token ?? ""} left</span>
                </div>
                <div className={`bar${left === 0 ? " empty" : left < 25 ? " low" : ""}`} role="img" aria-label={`${left}% of the budget left`}><span style={{ width: `${left}%` }} /></div>
                <span className="small muted">{left === 0 ? "Spent for this period. " : ""}Refills {everyDays(budget.periodDays)}</span>
              </div>
            );
          })}
          <h3 style={{ marginTop: 16 }}>Members</h3>
          {role.members.length === 0 ? <p className="muted small">Nobody holds this role yet.</p> : (
            <ul className="plain">
              {role.members.map((member) => <li key={member.member}>{member.kind === "Agent" ? "AI agent" : "Human"} · <span className="mono small">{member.member}</span></li>)}
            </ul>
          )}
        </div>
        <div>
          <h3>Allowed</h3>
          {role.description ? (
            <ul className="sentences role-rules">
              {role.description.details.map((detail, index) => (
                <li key={index} className={detail.startsWith("  · ") ? "rule" : "permission"}>{detail.replace(/^ {2}· /, "")}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

type BlockDraft =
  | { kind: "payments"; token: string; recipients: Array<{ address: string; label: string }>; amount: string; periodDays: number }
  | { kind: "swap"; tokenIn: string; tokensOut: string[]; protocols: ProtocolId[]; amount: string; periodDays: number; maxApproval: string }
  | { kind: "share-revenue"; sharesAccountId: string; amount: string; periodDays: number }
  | { kind: "lending"; protocol: LendingId; token: string; amount: string; periodDays: number; maxApproval: string }
  | { kind: "wrap"; amount: string; periodDays: number }
  | { kind: "solana-transfer"; token: string | null; recipients: Array<{ address: string; label: string }>; amount: string; periodDays: number };

const tokenSymbol = (address: string) => PROFILE.tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())?.symbol ?? short(address);

function RoleBuilder({ onClose, initialName = "", initialJob = null }: { onClose: () => void; initialName?: string; initialJob?: string | null }) {
  const wallets = useWallets();
  const navigate = useNavigate();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ agents: AgentRow[] }>("/v1/console/agents") });
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status });
  const registry = useQuery({ queryKey: ["registry"], queryFn: () => api<Registry>("/v1/console/registry") });
  const shares = useQuery({ queryKey: ["omni-shares"], queryFn: omni.shares });
  const sharesAccountId = shares.data?.deployed ? shares.data.accountId : null;
  const [name, setName] = useState(initialName);
  const [guardRequired, setGuardRequired] = useState(false);
  const [suppliersOnly, setSuppliersOnly] = useState(false);
  const [blocks, setBlocks] = useState<BlockDraft[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  const [preselected, setPreselected] = useState(false);
  useEffect(() => {
    // Agents created for this role are ticked by default.
    if (preselected || !agents.data || !initialName) return;
    setMembers(agents.data.agents.filter((agent) => agent.active && agent.role === initialName).map((agent) => agent.nearAccountId));
    setPreselected(true);
  }, [agents.data, initialName, preselected]);
  const [preview, setPreview] = useState<ProposalDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);

  const defaultToken = PROFILE.tokens[0]!.address;
  const addTransfers = () => {
    setBlocks((current) => [...current, { kind: "payments", token: defaultToken, recipients: [], amount: "1000", periodDays: 30 }]);
    setPreview(null);
  };
  const addSwap = (protocol: ProtocolId) => {
    setBlocks((current) => [...current, { kind: "swap", tokenIn: defaultToken, tokensOut: [], protocols: [protocol], amount: "10000", periodDays: 30, maxApproval: "1000" }]);
    setPreview(null);
    setCatalogOpen(false);
  };
  const addLending = (protocol: LendingId) => {
    const lending = PROFILE.lending?.[protocol];
    if (!lending) return;
    setBlocks((current) => [...current, { kind: "lending", protocol, token: lending.assets[0]!, amount: "1", periodDays: 30, maxApproval: "1" }]);
    setPreview(null);
    setCatalogOpen(false);
  };
  const addWrap = () => {
    setBlocks((current) => [...current, { kind: "wrap", amount: "0.01", periodDays: 1 }]);
    setPreview(null);
    setCatalogOpen(false);
  };
  const addSolana = () => {
    setBlocks((current) => [...current, { kind: "solana-transfer", token: null, recipients: [], amount: "0.1", periodDays: 1 }]);
    setPreview(null);
  };
  const addShareRevenue = () => {
    if (!sharesAccountId) return;
    setBlocks((current) => [...current, { kind: "share-revenue", sharesAccountId, amount: "0.01", periodDays: 7 }]);
    setPreview(null);
  };
  // A job picked in "Create your AI company" opens with its block already added.
  const jobApplied = useRef(false);
  useEffect(() => {
    if (jobApplied.current || !initialJob) return;
    if (initialJob === "payments") addTransfers();
    else if (initialJob === "treasury") addSwap("uniswap-v3");
    else if (initialJob === "revenue") {
      if (!sharesAccountId) return; // waits for the shares contract to load
      addShareRevenue();
    }
    jobApplied.current = true;
  }, [initialJob, sharesAccountId]);
  const supplierOptions = (registry.data?.suppliers ?? []).flatMap((supplier) =>
    supplier.wallets.filter((wallet) => wallet.chainId === PROFILE.chainId).map((wallet) => ({ address: wallet.address, label: supplier.name })));

  const update = (index: number, patch: Partial<BlockDraft>) => {
    setPreview(null);
    setBlocks((current) => current.map((block, position) => (position === index ? ({ ...block, ...patch } as BlockDraft) : block)));
  };

  const draft = (): RoleDraft => ({
    guardRequired, suppliersOnly,
    name,
    blocks: blocks.map((block): RoleBlock => block.kind === "payments"
      ? { kind: "payments", token: block.token as `0x${string}`, recipients: block.recipients.map((item) => ({ address: item.address as `0x${string}`, label: item.label })), budget: { amount: block.amount, periodDays: block.periodDays } }
      : block.kind === "share-revenue"
        ? { kind: "share-revenue", sharesAccountId: block.sharesAccountId, budget: { amount: block.amount, periodDays: block.periodDays } }
        : block.kind === "wrap"
          ? { kind: "wrap", budget: { amount: block.amount, periodDays: block.periodDays } }
        : block.kind === "solana-transfer"
          ? { kind: "solana-transfer", token: block.token, recipients: block.recipients, budget: { amount: block.amount, periodDays: block.periodDays } }
        : block.kind === "lending"
          ? { kind: "lending", protocol: block.protocol, token: block.token as `0x${string}`, budget: { amount: block.amount, periodDays: block.periodDays }, maxApproval: block.maxApproval }
          : { kind: "swap", tokenIn: block.tokenIn as `0x${string}`, tokensOut: block.tokensOut as `0x${string}`[], protocols: block.protocols, budget: { amount: block.amount, periodDays: block.periodDays }, maxApproval: block.maxApproval }),
    members: members.map((accountId) => ({ accountId, kind: "Agent" as const })),
  });

  /**
   * The server prepares the proposal; this browser recompiles the role and
   * refuses to sign unless the proposal says exactly the same thing.
   */
  async function verifiedProposal(role: RoleDraft): Promise<ProposalDraft> {
    const draft = await omni.roleProposal(role);
    const treasury = status.data?.treasury;
    if (!treasury) throw new Error("The treasury is not loaded yet");
    if (draft.receiverId !== treasury.daoAccountId) throw new Error(`The proposal targets ${draft.receiverId}, not the company DAO`);
    const decoded = decodeVaultCalls(draft.args.proposal.kind as Parameters<typeof decodeVaultCalls>[0], treasury.vaultAccountId);
    const changes = compileRole(role, PROFILE);
    const expected = changes.map((change) => ({ method: "queue_rule_change" as const, change }));
    if (!decoded || canonical(decoded) !== canonical(expected)) {
      throw new Error("The proposal prepared by the server does not match the role built here. Nothing was signed.");
    }
    const labels: Record<string, string> = Object.fromEntries(supplierOptions.map((option) => [option.address, option.label]));
    for (const block of role.blocks) if (block.kind === "payments") for (const recipient of block.recipients) labels[recipient.address] ??= recipient.label ?? recipient.address;
    if (status.data?.wallet) labels[status.data.wallet.address] = "company wallet";
    if (sharesAccountId) labels[stringHash(nearRecipient(sharesAccountId))] = `${nearRecipient(sharesAccountId)} (company shares)`;
    const context = { profile: PROFILE, labels, budgets: budgetsOf(changes, PROFILE), fullAddresses: true };
    return { ...draft, summary: expected.map((call) => describeVaultCall(call, context)) };
  }

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const ready = validRoleName(name) && blocks.length > 0 && blocks.every((block) =>
    Number(block.amount) > 0 && (block.kind === "payments"
      ? suppliersOnly || block.recipients.length > 0
      : block.kind === "solana-transfer" ? block.recipients.length > 0
      : block.kind === "share-revenue" || block.kind === "wrap" || (block.kind === "lending" ? Number(block.maxApproval) > 0 : block.tokensOut.length > 0 && block.protocols.length > 0 && Number(block.maxApproval) > 0)));
  // Say what is missing instead of a silently disabled button.
  const missing = !validRoleName(name)
    ? "Give the role a name."
    : blocks.length === 0
      ? "Add what this role allows: + Transfers, + DeFi… or + Share revenue"
      : blocks.some((block) => block.kind === "payments" && !suppliersOnly && block.recipients.length === 0)
        ? "Pick at least one recipient for the transfers."
        : blocks.some((block) => block.kind === "solana-transfer" && block.recipients.length === 0)
          ? "Add at least one Solana recipient."
        : blocks.some((block) => block.kind === "swap" && (block.tokensOut.length === 0 || block.protocols.length === 0))
          ? "Pick the tokens it may buy and at least one exchange."
          : blocks.some((block) => !(Number(block.amount) > 0))
            ? "Set a budget above zero."
            : null;

  return (
    <Card title="New role" action={<button className="ghost" onClick={onClose}>Cancel</button>}>
      {error ? <div className="alert error">{error}</div> : null}
      <div className="stack">
        <label><input type="checkbox" checked={guardRequired} onChange={(e) => { setGuardRequired(e.target.checked); setPreview(null); }} />Require Guard approval (needs the API)</label>
        <label><input type="checkbox" checked={suppliersOnly} onChange={(e) => { setSuppliersOnly(e.target.checked); setPreview(null); }} />Recipient must be a supplier</label>
        <label>
          Role name
            <input placeholder="treasury" value={name} onChange={(event) => { setName(event.target.value.toLowerCase()); setPreview(null); }} />
          {name && !validRoleName(name) ? <span className="small" style={{ color: "#b42318" }}>Lowercase letters, digits and dashes, 2 to 32 characters.</span> : null}
        </label>

        {blocks.map((block, index) => (
          <div className="block" key={index}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{block.kind === "payments" ? "Transfers" : block.kind === "solana-transfer" ? "Solana · transfers" : block.kind === "share-revenue" ? "Share revenue with shareholders" : block.kind === "wrap" ? "DeFi · wrap ETH into WETH" : block.kind === "lending" ? `DeFi · deposit on ${PROFILE.lending?.[block.protocol]?.name ?? block.protocol}` : `DeFi · swap on ${block.protocols.map((id) => PROFILE.protocols[id]?.name ?? id).join(" / ")}`}</strong>
              <button className="ghost" onClick={() => { setBlocks((current) => current.filter((_, position) => position !== index)); setPreview(null); }}>Remove</button>
            </div>
            {block.kind === "solana-transfer" ? (
              <>
                <div className="row wrap">
                  <label>Token
                    <select value={block.token ?? "SOL"} onChange={(event) => update(index, { token: event.target.value === "SOL" ? null : event.target.value })}>
                      {SOLANA_DEVNET.tokens.map((token) => <option key={token.symbol} value={token.mint ? token.symbol : "SOL"}>{token.symbol}</option>)}
                    </select>
                  </label>
                  <label>Budget ({block.token ?? "SOL"})<input inputMode="decimal" value={block.amount} onChange={(event) => update(index, { amount: event.target.value })} /></label>
                  <label>Every (days)<input type="number" min={1} value={block.periodDays} onChange={(event) => update(index, { periodDays: Number(event.target.value) })} /></label>
                </div>
                <span className="small muted">Allowed recipients (Solana wallets)</span>
                {block.recipients.map((recipient) => (
                  <div key={recipient.address} className="row wrap">
                    <span className="small">{recipient.label} <span className="mono">{recipient.address}</span></span>
                    <button className="ghost" onClick={() => update(index, { recipients: block.recipients.filter((item) => item.address !== recipient.address) })}>Remove</button>
                  </div>
                ))}
                <SolanaRecipient onAdd={(recipient) => update(index, { recipients: [...block.recipients.filter((item) => item.address !== recipient.address), recipient] })} />
                <span className="small muted">From the company's Solana wallet, on {SOLANA_DEVNET.name}. Token accounts of recipients are created when needed.</span>
              </>
            ) : block.kind === "wrap" ? (
              <>
                <div className="row wrap">
                  <label>Budget (ETH)<input inputMode="decimal" value={block.amount} onChange={(event) => update(index, { amount: event.target.value })} /></label>
                  <label>Every (days)<input type="number" min={1} value={block.periodDays} onChange={(event) => update(index, { periodDays: Number(event.target.value) })} /></label>
                </div>
                <span className="small muted">
                  ETH sent to WETH counts against the budget. Unwrapping is free: WETH always pays back the company wallet.
                </span>
              </>
            ) : block.kind === "lending" ? (
              <>
                <div className="row wrap">
                  <label>Asset
                    <select value={block.token} onChange={(event) => update(index, { token: event.target.value })}>
                      {(PROFILE.lending?.[block.protocol]?.assets ?? []).map((asset) => <option key={asset} value={asset}>{tokenSymbol(asset)}</option>)}
                    </select>
                  </label>
                  <label>Deposit budget ({tokenSymbol(block.token)})<input inputMode="decimal" value={block.amount} onChange={(event) => update(index, { amount: event.target.value })} /></label>
                  <label>Every (days)<input type="number" min={1} value={block.periodDays} onChange={(event) => update(index, { periodDays: Number(event.target.value) })} /></label>
                  <label>Largest approval<input inputMode="decimal" value={block.maxApproval} onChange={(event) => update(index, { maxApproval: event.target.value })} /></label>
                </div>
                <span className="small muted">
                  Deposits are always credited to the company wallet and withdrawals always return to it. Borrowing and any other pool function stay refused.
                </span>
              </>
            ) : block.kind === "share-revenue" ? (
              <>
                <div className="row wrap">
                  <label>Budget (ETH)<input inputMode="decimal" value={block.amount} onChange={(event) => update(index, { amount: event.target.value })} /></label>
                  <label>Every (days)<input type="number" min={1} value={block.periodDays} onChange={(event) => update(index, { periodDays: Number(event.target.value) })} /></label>
                </div>
                <p className="small muted">
                  ETH from the company wallet, through the Omni Bridge, to <code>{block.sharesAccountId}</code> only: the holders who vote receive it.
                  The bridge fee counts against the budget.
                </p>
              </>
            ) : block.kind === "payments" ? (
              <>
                <div className="row wrap">
                  <label>Token<TokenSelect value={block.token} onChange={(token) => update(index, { token })} /></label>
                  <label>Budget<input inputMode="decimal" value={block.amount} onChange={(event) => update(index, { amount: event.target.value })} /></label>
                  <label>Every (days)<input type="number" min={1} value={block.periodDays} onChange={(event) => update(index, { periodDays: Number(event.target.value) })} /></label>
                </div>
                <span className="small muted">Allowed recipients</span>
                <div className="row wrap">
                  {supplierOptions.map((option) => {
                    const checked = block.recipients.some((item) => item.address.toLowerCase() === option.address.toLowerCase());
                    return (
                      <label key={option.address} className="check">
                        <input type="checkbox" checked={checked} onChange={() => update(index, {
                          recipients: checked ? block.recipients.filter((item) => item.address.toLowerCase() !== option.address.toLowerCase()) : [...block.recipients, option],
                        })} />
                        {option.label} <span className="mono small muted">{short(option.address)}</span>
                      </label>
                    );
                  })}
                  {supplierOptions.length === 0 ? <span className="small muted">No supplier wallet on {PROFILE.name} yet. Add suppliers first, or enter an address:</span> : null}
                </div>
                <ManualRecipient onAdd={async (recipient) => {
                  // A new recipient is also a supplier request; the member who approves the role registers it.
                  await api("/v1/console/suppliers", { method: "POST", body: JSON.stringify({ name: recipient.label, address: recipient.address, chainId: PROFILE.chainId }) });
                  update(index, { recipients: [...block.recipients, recipient] });
                }} />
                {block.recipients.filter((item) => !supplierOptions.some((option) => option.address.toLowerCase() === item.address.toLowerCase())).map((item) => (
                  <span key={item.address} className="small">{item.label} <span className="mono">{item.address}</span> · new supplier, registered when another member approves this role</span>
                ))}
              </>
            ) : (
              <>
                <div className="row wrap">
                  <label>Sell<TokenSelect value={block.tokenIn} onChange={(tokenIn) => update(index, { tokenIn, tokensOut: block.tokensOut.filter((out) => out !== tokenIn) })} /></label>
                  <label>Budget ({tokenSymbol(block.tokenIn)})<input inputMode="decimal" value={block.amount} onChange={(event) => update(index, { amount: event.target.value })} /></label>
                  <label>Every (days)<input type="number" min={1} value={block.periodDays} onChange={(event) => update(index, { periodDays: Number(event.target.value) })} /></label>
                  <label>Largest approval<input inputMode="decimal" value={block.maxApproval} onChange={(event) => update(index, { maxApproval: event.target.value })} /></label>
                </div>
                <span className="small muted">Buy only</span>
                <div className="row wrap">
                  {PROFILE.tokens.filter((token) => token.address !== block.tokenIn).map((token) => {
                    const checked = block.tokensOut.includes(token.address);
                    return (
                      <label key={token.address} className="check">
                        <input type="checkbox" checked={checked} onChange={() => update(index, { tokensOut: checked ? block.tokensOut.filter((out) => out !== token.address) : [...block.tokensOut, token.address] })} />
                        {token.symbol}
                      </label>
                    );
                  })}
                </div>
                <span className="small muted">On these exchanges</span>
                <div className="row wrap">
                  {PROTOCOLS.map(([id, protocol]) => {
                    const checked = block.protocols.includes(id);
                    return (
                      <label key={id} className="check">
                        <input type="checkbox" checked={checked} onChange={() => update(index, { protocols: checked ? block.protocols.filter((item) => item !== id) : [...block.protocols, id] })} />
                        {protocol.name}
                      </label>
                    );
                  })}
                </div>
                <span className="small muted">Bought tokens always go back to the company wallet; approvals are capped per transaction, never unlimited.</span>
              </>
            )}
          </div>
        ))}

        <div className="row wrap">
          <button onClick={addTransfers} title="Send tokens to registered suppliers or the company wallet, within a budget">+ Transfers</button>
          <button onClick={() => setCatalogOpen(true)} title="Pick a protocol from the catalog">+ DeFi…</button>
          <button onClick={addSolana} title="Send SOL or USDC on Solana to listed wallets, within a budget">+ Solana transfers</button>
          <button
            onClick={addShareRevenue}
            disabled={!sharesAccountId || blocks.some((block) => block.kind === "share-revenue")}
            title={sharesAccountId ? "Let the agent send ETH to the company's shareholders, within a budget" : "Issue shares first (Shares page)"}
          >
            + Share revenue
          </button>
        </div>

        <div>
          <span className="small muted">Agents holding this role</span>
          <div className="row wrap">
            {(agents.data?.agents ?? []).filter((agent) => agent.active).map((agent) => {
              const checked = members.includes(agent.nearAccountId);
              return (
                <label key={agent.id} className="check">
                  <input type="checkbox" checked={checked} onChange={() => { setMembers((current) => checked ? current.filter((item) => item !== agent.nearAccountId) : [...current, agent.nearAccountId]); setPreview(null); }} />
                  {agent.name} <span className="mono small muted">{agent.nearAccountId}</span>
                  {checked && name && agent.role !== name ? <span className="small warn"> · its requests use role "{agent.role}": name this role "{agent.role}" or update AGENT_ROLE</span> : null}
                </label>
              );
            })}
            {(agents.data?.agents ?? []).length === 0 ? <span className="small muted">No agent yet: you can add members later.</span> : null}
          </div>
        </div>

        <div className="row wrap">
          <button
            disabled={!ready || Boolean(busy)}
            onClick={() => void run("preview", async () => setPreview(await verifiedProposal(draft())))}
          >
            {busy === "preview" ? "Preparing…" : "Preview what members vote on"}
          </button>
          {!ready && missing ? <span className="small muted">{missing}</span> : null}
        </div>
        <p className="small muted">
          Then: submit to the members' vote → members approve in Decisions → the role applies after the veto window and shows up below.
        </p>

        {catalogOpen ? <DefiCatalog onPick={addSwap} onPickLending={addLending} onPickWrap={addWrap} onClose={() => setCatalogOpen(false)} /> : null}

        {preview ? (
          <div className="decision">
            <header><div><span className="eyebrow">Members will vote on</span><h3>{preview.title}</h3></div></header>
            <SentenceList items={preview.summary} />
            <p className="small muted verified">✓ Checked in your browser: the proposal prepared by Euthyna is exactly this role.</p>
            <footer className="row wrap">
              <span className="small muted">Submitting locks a 0.1 NEAR proposal bond, returned when the proposal passes.</span>
              <div className="spacer" />
              <button
                className="primary"
                disabled={!wallets.nearAccountId || Boolean(busy)}
                title={wallets.nearAccountId ? "Sign the proposal with your NEAR wallet" : "Connect your NEAR wallet first"}
                onClick={() => void run("submit", async () => {
                  await signDaoProposal(wallets.nearAccountId, preview);
                  navigate("/governance");
                })}
              >
                {busy === "submit" ? "Signing…" : "Submit to the members' vote"}
              </button>
            </footer>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Protocols a role can allow. Each one has a rule template checked by the vault
 * (contracts/omniroles-conditions presets); the others are listed as coming.
 */
const DEFI_CATALOG: Array<{ id: string; name: string; action: string; protocol?: ProtocolId; lending?: LendingId; wrap?: true; note: string }> = [
  { id: "weth", name: "WETH", action: "Wrap & unwrap", wrap: true, note: "Turn ETH into WETH within a budget, so it can be swapped or deposited; unwrapping returns ETH to the wallet." },
  { id: "uniswap-v3", name: "Uniswap V3", action: "Swap", protocol: "uniswap-v3", note: "Swap within a budget; bought tokens always return to the company wallet." },
  { id: "uniswap-v2", name: "Uniswap V2", action: "Swap", protocol: "uniswap-v2", note: "Same rules, on the V2 router." },
  { id: "aave-v3", name: "Aave V3", action: "Deposit & withdraw", lending: "aave-v3", note: "Deposits within a budget earn yield for the company wallet only; withdrawals return to it." },
];

function DefiCatalog({ onPick, onPickLending, onPickWrap, onClose }: { onPick: (protocol: ProtocolId) => void; onPickLending: (protocol: LendingId) => void; onPickWrap: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="catalog-backdrop" role="presentation" onClick={onClose}>
      <div className="catalog" role="dialog" aria-modal="true" aria-label="DeFi catalog" onClick={(event) => event.stopPropagation()}>
        <header className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h3>DeFi catalog</h3>
            <p className="small muted">What the agent may do on each protocol. Everything else stays refused by the vault.</p>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="catalog-list">
          {DEFI_CATALOG.map((item) => (
            <button
              key={item.id}
              className="catalog-item"
              disabled={!item.wrap && !item.protocol && !(item.lending && PROFILE.lending?.[item.lending])}
              onClick={() => (item.wrap ? onPickWrap() : item.protocol ? onPick(item.protocol) : item.lending ? onPickLending(item.lending) : undefined)}
            >
              <span className="catalog-name">{item.name}<span className="catalog-action">{item.action}</span></span>
              <span className="small muted">{item.note}</span>
              {!item.wrap && !item.protocol && !(item.lending && PROFILE.lending?.[item.lending]) ? <span className="catalog-soon">Soon</span> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SolanaRecipient({ onAdd }: { onAdd: (recipient: { address: string; label: string }) => void }) {
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const valid = isSolanaAddress(address) && label.trim().length > 0;
  return (
    <div className="row wrap">
      <input placeholder="Name" value={label} onChange={(event) => setLabel(event.target.value)} />
      <input className="mono" placeholder="Solana address (base58)" value={address} onChange={(event) => setAddress(event.target.value.trim())} />
      <button disabled={!valid} onClick={() => { onAdd({ address, label: label.trim() }); setAddress(""); setLabel(""); }}>Add</button>
      {address && !isSolanaAddress(address) ? <span className="small" style={{ color: "#b42318" }}>Not a Solana address.</span> : null}
    </div>
  );
}

function TokenSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {PROFILE.tokens.map((token) => <option key={token.address} value={token.address}>{token.symbol}</option>)}
    </select>
  );
}

function ManualRecipient({ onAdd }: { onAdd: (recipient: { address: string; label: string }) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address) && label.trim().length > 0;
  return (
    <div className="row wrap">
      <input placeholder="Name" value={label} onChange={(event) => setLabel(event.target.value)} />
      <input placeholder="0x… address" value={address} onChange={(event) => setAddress(event.target.value.trim())} />
      <button disabled={!valid || busy} onClick={() => void (async () => {
        setBusy(true);
        setError(null);
        try {
          await onAdd({ address: getAddress(address), label: label.trim() });
          setLabel("");
          setAddress("");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      })()}>Add recipient</button>
      {error ? <span className="small warn">{error}</span> : null}
    </div>
  );
}

/** JSON with sorted keys, to compare two decoded proposals. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : typeof item === "bigint" ? item.toString() : item);
}

