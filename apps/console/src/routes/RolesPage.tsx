import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useRef, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { getAddress } from "viem";
import { isSolanaAddress, SOLANA_DEVNET } from "@euthyna/sdk/solana";
import { BASE_SEPOLIA, budgetsOf, cardAccountIdOf, compileRole, decodeVaultCalls, describeVaultCall, NEAR_TESTNET_TOKENS, nearRecipient, stringHash, validNearAccountId, validRoleName, type RuleChange, type LendingId, type ProtocolId, type RoleBlock, type RoleDraft } from "@euthyna/sdk/roles";

import { api, type AgentRow } from "../api.js";
import { Kicker, NightPanel, PageTitle, SectionHead, Slab } from "../components/design.js";
import { displayAccount, PageState, everyDays, short } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type ProposalDraft, type RoleView } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";
import { summarizeRoleChanges, type RoleSummary } from "../lib/role-summary.js";
import { forkedLawOf, LAW_PARAM, type ForkedLaw } from "./onboarding-law.js";

type Registry = { suppliers: Array<{ id: string; name: string; wallets: Array<{ chainId: number; address: string }> }> };

const PROFILE = BASE_SEPOLIA;
const PROTOCOLS = Object.entries(PROFILE.protocols) as Array<[ProtocolId, { name: string; router: string }]>;
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV"];

const FIELD_ROW: CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" };
const BLOCK: CSSProperties = { border: "1px solid rgba(13,23,48,.16)", background: "rgba(255,255,255,.62)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 };
const NOTE: CSSProperties = { fontSize: 11.5, color: "#66718C", lineHeight: 1.4, margin: 0 };
const PLAIN_BUTTON: CSSProperties = { border: 0, background: "none", color: "#4A5675", fontSize: 12, cursor: "pointer", padding: 0 };
const MINI_BUTTON: CSSProperties = { padding: "7px 10px", font: "700 10.5px var(--font-brand)", letterSpacing: ".14em", border: "1px solid rgba(13,23,48,.25)", background: "rgba(255,255,255,.6)", color: "#0D1730", cursor: "pointer" };
const SUB_INPUT: CSSProperties = { padding: "7px 10px", border: "1px solid rgba(13,23,48,.2)", background: "#fff", font: "12px var(--font-mono)", color: "#0D1730", minWidth: 0 };
const ADD_BUTTON: CSSProperties = { padding: "8px 12px", border: "1px dashed rgba(13,23,48,.35)", background: "rgba(255,255,255,.5)", font: "600 12.5px var(--font-ui)", color: "#0D1730", cursor: "pointer" };
const CHECK_ROW: CSSProperties = { display: "flex", flexDirection: "row", gap: 8, alignItems: "center", fontSize: 12.5, color: "#0D1730", marginBottom: 0 };
const CHECKBOX: CSSProperties = { width: 14, height: 14, minWidth: 0, minHeight: 0, accentColor: "#C9890C", margin: 0 };
const ERROR_BOX: CSSProperties = { border: "1px solid rgba(217,87,59,.55)", background: "#FBE3D6", color: "var(--terra-ink)", padding: "10px 14px", fontSize: 13 };

/** One labelled field of the role builder: same frame for every block. */
function Field({ label, children, style }: { label: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="field-app" style={{ flex: 1, minWidth: 180, ...style }}>
      <label style={{ marginBottom: 0 }}>{label}</label>
      {children}
    </div>
  );
}

export function RolesPage() {
  const roles = useQuery({ queryKey: ["omni-roles"], queryFn: omni.roles, refetchInterval: 15_000 });
  // Same query as "On its way" above: a role voted or being voted is not "no role yet, create one".
  const governance = useQuery({ queryKey: ["omni-governance"], queryFn: omni.governance, refetchInterval: 15_000 });
  const onItsWay = (governance.data?.rules ?? []).some((rule) => rule.state === "Queued")
    || (governance.data?.proposals ?? []).some((proposal) => proposal.status === "InProgress");
  const [params, setParams] = useSearchParams();
  const [building, setBuilding] = useState(params.get("new") === "1");
  const suggested = params.get("role") ?? "";
  const job = params.get("job");
  const law = forkedLawOf(params.get(LAW_PARAM));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ font: "600 12px var(--font-ui)", color: "#66718C" }}>The law</span>
          <PageTitle>RULES</PageTitle>
          <span style={{ fontSize: 14, color: "#4A5675", maxWidth: 720 }}>
            A role is what an agent may do with company funds: which contracts, which counterparties, which budget.
            Everything else is refused by the vault.
          </span>
        </div>
        {!building ? (
          <button className="btn-line" style={{ marginLeft: "auto", whiteSpace: "nowrap" }} onClick={() => setBuilding(true)}>
            NEW ROLE
          </button>
        ) : null}
      </header>
      <div
        className="g2"
        style={{ display: "grid", gridTemplateColumns: building ? "minmax(0, .92fr) minmax(0, 1.08fr)" : "minmax(0, 1fr)", gap: 20, alignItems: "start" }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <RolesInProgress />
          <PageState
            loading={roles.isLoading}
            error={roles.error}
            empty={roles.data?.roles.length === 0}
            emptyContent={building ? <></> : (
              <Slab style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
                <span className="empty-state">
                  {onItsWay
                    ? "No active role yet. The role on its way applies once its vote and veto window are over."
                    : "No active role yet. Create one, the members vote on it, and it applies after the veto window."}
                </span>
                {onItsWay ? null : <button className="btn-ori" style={{ alignSelf: "flex-start" }} onClick={() => setBuilding(true)}>CREATE THE FIRST ROLE</button>}
              </Slab>
            )}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {(roles.data?.roles ?? []).map((role) => <RoleCard key={role.name} role={role} />)}
            </div>
          </PageState>
        </div>
        {building ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <RoleBuilder initialName={suggested} initialJob={job} initialLaw={law} onClose={() => { setBuilding(false); setParams({}); }} />
          </div>
        ) : null}
      </div>
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
    if (threshold && typeof threshold === "object" && "Weight" in threshold) return Number(threshold.Weight);
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
    <Slab style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
      <SectionHead
        left={<Kicker>On its way</Kicker>}
        right={<Link className="section-link" to="/governance">OPEN DECISIONS →</Link>}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.flatMap((item) => item.roles.map((role) => (
          <div key={`${item.key}-${role.role}`} style={{ padding: "12px 14px", border: "1px solid rgba(13,23,48,.12)", background: "rgba(255,255,255,.55)", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 13.5 }}>Role "{role.role}"{role.deleted ? " · deleted" : role.disabled ? " · disabled" : ""}</strong>
              <span style={{ fontSize: 12.5, color: "#66718C" }}>{item.status}</span>
            </div>
            {role.allows.length ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {role.allows.map((line, index) => (
                  <span key={index} style={{ fontSize: 12.5, color: line.startsWith("  ·") ? "#66718C" : "#4A5675", paddingLeft: line.startsWith("  ·") ? 12 : 0 }}>
                    {line.replace(/^\s*·\s*/, "")}
                  </span>
                ))}
              </div>
            ) : null}
            {role.budgets.length ? <span style={{ fontSize: 12.5 }}>Budget: {role.budgets.join(" · ")}</span> : null}
            {role.holders.length ? <span style={{ fontSize: 12.5 }}>Held by {role.holders.join(", ")}</span> : null}
            {role.removedHolders.length ? <span style={{ fontSize: 12.5 }}>No longer held by {role.removedHolders.join(", ")}</span> : null}
          </div>
        )))}
      </div>
    </Slab>
  );
}

function RoleCard({ role }: { role: RoleView }) {
  const details = role.description?.details ?? [];
  let permission = 0;
  return (
    <Slab style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <b style={{ font: "800 17px var(--font-brand)", letterSpacing: ".1em" }}>ROLE · {role.name.toUpperCase()}</b>
        <span style={{ fontSize: 12, fontWeight: 700, color: role.enabled ? "var(--aegean-ink)" : "var(--terra-ink)" }}>
          ● {role.enabled ? "active" : "disabled"}{role.members.length ? ` · ${role.members.map((member) => short(member.member, 12)).join(", ")}` : ""}
        </span>
      </div>
      <Kicker color="var(--gold-ink)" style={{ fontSize: 10 }}>Budgets</Kicker>
      {role.budgets.length === 0 ? <p style={{ ...NOTE, fontSize: 13 }}>No budget: this role cannot move value.</p> : role.budgets.map((budget) => {
        const available = Number(budget.available ?? 0);
        const max = Number(budget.max ?? 0);
        const left = max > 0 ? Math.max(0, Math.min(100, Math.round((available / max) * 100))) : 0;
        return (
          <div key={budget.key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, color: "#4A5675" }}>
              <span>{budget.label}{budget.periodDays ? ` · ${everyDays(budget.periodDays)}` : ""}</span>
              <b className="mono" style={{ font: "600 12px var(--font-mono)", color: "#0D1730" }}>
                {available.toLocaleString()} / {max.toLocaleString()}{budget.token ? ` ${budget.token}` : ""} left
              </b>
            </div>
            <div className="groove" role="img" aria-label={`${left}% of the budget left`}><i style={{ width: `${left}%` }} /></div>
            <span style={{ fontSize: 11.5, color: "#66718C" }}>{left === 0 ? "Spent for this period. " : ""}Refills {everyDays(budget.periodDays)}</span>
          </div>
        );
      })}
      <Kicker color="var(--gold-ink)" style={{ fontSize: 10, marginTop: 4 }}>Allowed</Kicker>
      {details.length ? (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {details.map((detail, index) => {
            const sub = detail.startsWith("  · ");
            if (!sub) permission += 1;
            const numeral = ROMAN[permission - 1] ?? String(permission);
            return sub ? (
              <div key={index} style={{ display: "grid", gridTemplateColumns: "22px minmax(0, 1fr)", gap: 8, fontSize: 12.5, color: "#4A5675", padding: "4px 0 4px 22px" }}>
                <span style={{ font: "700 12px var(--font-brand)", color: "#66718C" }}>·</span>
                <span>{detail.replace(/^ {2}· /, "")}</span>
              </div>
            ) : (
              <div key={index} className="row-rule" style={{ borderTop: index === 0 ? "none" : "1px solid rgba(13,23,48,.1)", padding: "6px 0" }}>
                <b>{numeral}</b>
                <span style={{ fontSize: 13.5 }}>{detail}</span>
              </div>
            );
          })}
        </div>
      ) : null}
      <div style={{ fontSize: 12.5, color: "#4A5675", borderTop: "1px solid rgba(13,23,48,.1)", paddingTop: 8 }}>
        Members: {role.members.length === 0 ? "Nobody holds this role yet." : role.members.map((member) => `${member.kind === "Agent" ? "AI agent" : "Human"} · ${short(member.member, 10)}`).join(" · ")}
      </div>
    </Slab>
  );
}

type BlockDraft =
  | { kind: "payments"; token: string; recipients: Array<{ address: string; label: string }>; amount: string; periodDays: number }
  | { kind: "swap"; tokenIn: string; tokensOut: string[]; protocols: ProtocolId[]; amount: string; periodDays: number; maxApproval: string }
  | { kind: "share-revenue"; sharesAccountId: string; amount: string; periodDays: number }
  | { kind: "lending"; protocol: LendingId; token: string; amount: string; periodDays: number; maxApproval: string }
  | { kind: "wrap"; amount: string; periodDays: number }
  | { kind: "solana-transfer"; token: string | null; recipients: Array<{ address: string; label: string }>; amount: string; periodDays: number }
  | { kind: "near-transfer"; token: string; receivers: Array<{ accountId: string; label: string }>; amount: string; periodDays: number; maxPerTransfer: string; minPerTransfer: string };

const tokenSymbol = (address: string) => PROFILE.tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())?.symbol ?? short(address);

function RoleBuilder({ onClose, initialName = "", initialJob = null, initialLaw = null }: { onClose: () => void; initialName?: string; initialJob?: string | null; initialLaw?: ForkedLaw | null }) {
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
  const addNear = () => {
    setBlocks((current) => [...current, { kind: "near-transfer", token: NEAR_TESTNET_TOKENS[0]!.symbol, receivers: [], amount: "10", periodDays: 1, maxPerTransfer: "5", minPerTransfer: "" }]);
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
    if (jobApplied.current || (!initialJob && !initialLaw)) return;
    // A law forked from /rob (onboarding-law.ts) opens with its own block, every field still editable.
    if (initialLaw) {
      setBlocks([{ ...initialLaw.block, receivers: [...initialLaw.block.receivers] }]);
      setPreview(null);
    } else if (initialJob === "payments") addTransfers();
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
        : block.kind === "near-transfer"
          ? { kind: "near-transfer", token: block.token, receivers: block.receivers, budget: { amount: block.amount, periodDays: block.periodDays }, maxPerTransfer: block.maxPerTransfer, ...(block.minPerTransfer ? { minPerTransfer: block.minPerTransfer } : {}) }
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
    // The server may add one change this browser cannot know: clearing the NEAR
    // permissions the role already has on the vault. It only ever removes rights.
    const clear: RuleChange = { SetNearPermissions: { role: role.name, permissions: [] } };
    const cleared = [...expected, { method: "queue_rule_change" as const, change: clear }];
    const clearAllowed = !role.blocks.some((block) => block.kind === "near-transfer");
    if (!decoded || (canonical(decoded) !== canonical(expected) && !(clearAllowed && canonical(decoded) === canonical(cleared)))) {
      throw new Error("The proposal prepared by the server does not match the role built here. Nothing was signed.");
    }
    const voted = canonical(decoded) === canonical(expected) ? expected : cleared;
    const labels: Record<string, string> = Object.fromEntries(supplierOptions.map((option) => [option.address, option.label]));
    for (const block of role.blocks) if (block.kind === "payments") for (const recipient of block.recipients) labels[recipient.address] ??= recipient.label ?? recipient.address;
    if (status.data?.wallet) labels[status.data.wallet.address] = "company wallet";
    if (sharesAccountId) labels[stringHash(nearRecipient(sharesAccountId))] = `${nearRecipient(sharesAccountId)} (company shares)`;
    const context = { profile: PROFILE, labels, budgets: budgetsOf(changes, PROFILE), fullAddresses: true };
    return { ...draft, summary: voted.map((call) => describeVaultCall(call, context)) };
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
      : block.kind === "near-transfer" ? block.receivers.length > 0 && (block.minPerTransfer === "" || (Number(block.minPerTransfer) > 0 && Number(block.minPerTransfer) <= Number(block.maxPerTransfer))) && Number(block.maxPerTransfer) <= Number(block.amount)
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
        : blocks.some((block) => block.kind === "near-transfer" && block.receivers.length === 0)
          ? "Add at least one NEAR account to pay."
        : blocks.some((block) => block.kind === "near-transfer" && !((block.minPerTransfer === "" || (Number(block.minPerTransfer) > 0 && Number(block.minPerTransfer) <= Number(block.maxPerTransfer))) && Number(block.maxPerTransfer) <= Number(block.amount)))
          ? "NEAR transfers: smallest above zero, up to the largest, and the largest within the budget."
        : blocks.some((block) => block.kind === "swap" && (block.tokensOut.length === 0 || block.protocols.length === 0))
          ? "Pick the tokens it may buy and at least one exchange."
          : blocks.some((block) => !(Number(block.amount) > 0))
            ? "Set a budget above zero."
            : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Slab style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12, boxShadow: "0 0 0 2px rgba(201,137,12,.55), var(--shadow-slab)" }}>
        {error ? <div style={ERROR_BOX}>{error}</div> : null}
        <SectionHead left={<Kicker>New role</Kicker>} right={<button onClick={onClose} style={PLAIN_BUTTON}>Cancel</button>} />
        <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="field-app" style={{ flex: "0 0 200px" }}>
            <label style={{ marginBottom: 0 }}>Role name</label>
            <input placeholder="treasury" value={name} onChange={(event) => { setName(event.target.value.toLowerCase()); setPreview(null); }} />
            {name && !validRoleName(name) ? <span style={{ fontSize: 12, color: "#B8442B" }}>Lowercase letters, digits and dashes, 2 to 32 characters.</span> : null}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={CHECK_ROW}>
              <input type="checkbox" checked={guardRequired} onChange={(e) => { setGuardRequired(e.target.checked); setPreview(null); }} style={CHECKBOX} />
              Require Guard approval (needs the API)
            </label>
            <label style={CHECK_ROW}>
              <input type="checkbox" checked={suppliersOnly} onChange={(e) => { setSuppliersOnly(e.target.checked); setPreview(null); }} style={CHECKBOX} />
              Recipient must be a supplier
            </label>
          </div>
        </div>

        {blocks.map((block, index) => (
          <div style={BLOCK} key={index}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
              <b style={{ font: "800 13px var(--font-brand)", letterSpacing: ".12em" }}>{block.kind === "payments" ? "Transfers" : block.kind === "solana-transfer" ? "Solana · transfers" : block.kind === "near-transfer" ? "NEAR · pay in tokens" : block.kind === "share-revenue" ? "Share revenue with shareholders" : block.kind === "wrap" ? "DeFi · wrap ETH into WETH" : block.kind === "lending" ? `DeFi · deposit on ${PROFILE.lending?.[block.protocol]?.name ?? block.protocol}` : `DeFi · swap on ${block.protocols.map((id) => PROFILE.protocols[id]?.name ?? id).join(" / ")}`}</b>
              <button onClick={() => { setBlocks((current) => current.filter((_, position) => position !== index)); setPreview(null); }} style={PLAIN_BUTTON}>Remove</button>
            </div>
            {block.kind === "near-transfer" ? (
              <>
                <div style={FIELD_ROW}>
                  <Field label="Token">
                    <select value={block.token} onChange={(event) => update(index, { token: event.target.value })}>
                      {NEAR_TESTNET_TOKENS.map((token) => <option key={token.accountId} value={token.symbol}>{token.symbol}</option>)}
                    </select>
                  </Field>
                  <Field label={`Budget (${block.token})`}>
                    <input inputMode="decimal" value={block.amount} onChange={(event) => update(index, { amount: event.target.value })} />
                  </Field>
                  <Field label="Every (days)">
                    <input type="number" min={1} value={block.periodDays} onChange={(event) => update(index, { periodDays: Number(event.target.value) })} />
                  </Field>
                  <Field label="Smallest transfer">
                    <input inputMode="decimal" placeholder={`${Number(block.amount) / 100 || ""} (budget ÷ 100)`} value={block.minPerTransfer} onChange={(event) => update(index, { minPerTransfer: event.target.value })} />
                  </Field>
                  <Field label="Largest transfer">
                    <input inputMode="decimal" value={block.maxPerTransfer} onChange={(event) => update(index, { maxPerTransfer: event.target.value })} />
                  </Field>
                </div>
                <span style={NOTE}>Accounts it may pay (NEAR)</span>
                {block.receivers.map((receiver) => (
                  <div key={receiver.accountId} style={FIELD_ROW}>
                    <span style={{ fontSize: 12.5 }}>{receiver.label} <span className="mono" style={{ fontSize: 12 }}>{receiver.accountId}</span></span>
                    <button style={MINI_BUTTON} onClick={() => update(index, { receivers: block.receivers.filter((item) => item.accountId !== receiver.accountId) })}>Remove</button>
                  </div>
                ))}
                <div style={FIELD_ROW}>
                  {(agents.data?.agents ?? []).filter((agent) => agent.active && cardOf(agent.nearAccountId)).map((agent) => {
                    const card = cardOf(agent.nearAccountId)!;
                    const listed = block.receivers.some((item) => item.accountId === card);
                    return listed ? null : (
                      <button key={card} style={MINI_BUTTON} onClick={() => update(index, { receivers: [...block.receivers, { accountId: card, label: `${agent.name}'s card` }] })}>+ {agent.name}'s card</button>
                    );
                  })}
                </div>
                <NearReceiver onAdd={(receiver) => update(index, { receivers: [...block.receivers.filter((item) => item.accountId !== receiver.accountId), receiver] })} />
                <span style={NOTE}>
                  From the tokens the vault holds on NEAR testnet. The vault registers on the token when this role is voted;
                  each account paid must be registered on the token too, or the transfer fails and the budget comes back.
                </span>
              </>
            ) : block.kind === "solana-transfer" ? (
              <>
                <div style={FIELD_ROW}>
                  <Field label="Token">
                    <select value={block.token ?? "SOL"} onChange={(event) => update(index, { token: event.target.value === "SOL" ? null : event.target.value })}>
                      {SOLANA_DEVNET.tokens.map((token) => <option key={token.symbol} value={token.mint ? token.symbol : "SOL"}>{token.symbol}</option>)}
                    </select>
                  </Field>
                  <Field label={`Budget (${block.token ?? "SOL"})`}>
                    <input inputMode="decimal" value={block.amount} onChange={(event) => update(index, { amount: event.target.value })} />
                  </Field>
                  <Field label="Every (days)">
                    <input type="number" min={1} value={block.periodDays} onChange={(event) => update(index, { periodDays: Number(event.target.value) })} />
                  </Field>
                </div>
                <span style={NOTE}>Allowed recipients (Solana wallets)</span>
                {block.recipients.map((recipient) => (
                  <div key={recipient.address} style={FIELD_ROW}>
                    <span style={{ fontSize: 12.5 }}>{recipient.label} <span className="mono" style={{ fontSize: 12 }}>{recipient.address}</span></span>
                    <button style={MINI_BUTTON} onClick={() => update(index, { recipients: block.recipients.filter((item) => item.address !== recipient.address) })}>Remove</button>
                  </div>
                ))}
                <SolanaRecipient onAdd={(recipient) => update(index, { recipients: [...block.recipients.filter((item) => item.address !== recipient.address), recipient] })} />
                <span style={NOTE}>From the company's Solana wallet, on {SOLANA_DEVNET.name}. Token accounts of recipients are created when needed.</span>
              </>
            ) : block.kind === "wrap" ? (
              <>
                <div style={FIELD_ROW}>
                  <Field label="Budget (ETH)">
                    <input inputMode="decimal" value={block.amount} onChange={(event) => update(index, { amount: event.target.value })} />
                  </Field>
                  <Field label="Every (days)">
                    <input type="number" min={1} value={block.periodDays} onChange={(event) => update(index, { periodDays: Number(event.target.value) })} />
                  </Field>
                </div>
                <span style={NOTE}>
                  ETH sent to WETH counts against the budget. Unwrapping is free: WETH always pays back the company wallet.
                </span>
              </>
            ) : block.kind === "lending" ? (
              <>
                <div style={FIELD_ROW}>
                  <Field label="Asset">
                    <select value={block.token} onChange={(event) => update(index, { token: event.target.value })}>
                      {(PROFILE.lending?.[block.protocol]?.assets ?? []).map((asset) => <option key={asset} value={asset}>{tokenSymbol(asset)}</option>)}
                    </select>
                  </Field>
                  <Field label={`Deposit budget (${tokenSymbol(block.token)})`}>
                    <input inputMode="decimal" value={block.amount} onChange={(event) => update(index, { amount: event.target.value })} />
                  </Field>
                  <Field label="Every (days)">
                    <input type="number" min={1} value={block.periodDays} onChange={(event) => update(index, { periodDays: Number(event.target.value) })} />
                  </Field>
                  <Field label="Largest approval">
                    <input inputMode="decimal" value={block.maxApproval} onChange={(event) => update(index, { maxApproval: event.target.value })} />
                  </Field>
                </div>
                <span style={NOTE}>
                  Deposits are always credited to the company wallet and withdrawals always return to it. Borrowing and any other pool function stay refused.
                </span>
              </>
            ) : block.kind === "share-revenue" ? (
              <>
                <div style={FIELD_ROW}>
                  <Field label="Budget (ETH)">
                    <input inputMode="decimal" value={block.amount} onChange={(event) => update(index, { amount: event.target.value })} />
                  </Field>
                  <Field label="Every (days)">
                    <input type="number" min={1} value={block.periodDays} onChange={(event) => update(index, { periodDays: Number(event.target.value) })} />
                  </Field>
                </div>
                <p style={NOTE}>
                  ETH from the company wallet, through the Omni Bridge, to <code style={{ font: "12px var(--font-mono)" }}>{block.sharesAccountId}</code> only: the holders who vote receive it.
                  The bridge fee counts against the budget.
                </p>
              </>
            ) : block.kind === "payments" ? (
              <>
                <div style={FIELD_ROW}>
                  <Field label="Token"><TokenSelect value={block.token} onChange={(token) => update(index, { token })} /></Field>
                  <Field label="Budget">
                    <input inputMode="decimal" value={block.amount} onChange={(event) => update(index, { amount: event.target.value })} />
                  </Field>
                  <Field label="Every (days)">
                    <input type="number" min={1} value={block.periodDays} onChange={(event) => update(index, { periodDays: Number(event.target.value) })} />
                  </Field>
                </div>
                <span style={NOTE}>Allowed recipients</span>
                <div style={FIELD_ROW}>
                  {supplierOptions.map((option) => {
                    const checked = block.recipients.some((item) => item.address.toLowerCase() === option.address.toLowerCase());
                    return (
                      <label key={option.address} className="check" style={CHECK_ROW}>
                        <input type="checkbox" checked={checked} onChange={() => update(index, {
                          recipients: checked ? block.recipients.filter((item) => item.address.toLowerCase() !== option.address.toLowerCase()) : [...block.recipients, option],
                        })} style={CHECKBOX} />
                        {option.label} <span className="mono" style={{ fontSize: 11.5, color: "#66718C" }}>{short(option.address)}</span>
                      </label>
                    );
                  })}
                  {supplierOptions.length === 0 ? <span style={NOTE}>No supplier wallet on {PROFILE.name} yet. Add suppliers first, or enter an address:</span> : null}
                </div>
                <ManualRecipient onAdd={async (recipient) => {
                  // A new recipient is also a supplier request; the member who approves the role registers it.
                  await api("/v1/console/suppliers", { method: "POST", body: JSON.stringify({ name: recipient.label, address: recipient.address, chainId: PROFILE.chainId }) });
                  update(index, { recipients: [...block.recipients, recipient] });
                }} />
                {block.recipients.filter((item) => !supplierOptions.some((option) => option.address.toLowerCase() === item.address.toLowerCase())).map((item) => (
                  <span key={item.address} style={{ fontSize: 12 }}>{item.label} <span className="mono" style={{ fontSize: 11.5 }}>{item.address}</span> · new supplier, registered when another member approves this role</span>
                ))}
              </>
            ) : (
              <>
                <div style={FIELD_ROW}>
                  <Field label="Sell">
                    <TokenSelect value={block.tokenIn} onChange={(tokenIn) => update(index, { tokenIn, tokensOut: block.tokensOut.filter((out) => out !== tokenIn) })} />
                  </Field>
                  <Field label={`Budget (${tokenSymbol(block.tokenIn)})`}>
                    <input inputMode="decimal" value={block.amount} onChange={(event) => update(index, { amount: event.target.value })} />
                  </Field>
                  <Field label="Every (days)">
                    <input type="number" min={1} value={block.periodDays} onChange={(event) => update(index, { periodDays: Number(event.target.value) })} />
                  </Field>
                  <Field label="Largest approval">
                    <input inputMode="decimal" value={block.maxApproval} onChange={(event) => update(index, { maxApproval: event.target.value })} />
                  </Field>
                </div>
                <span style={NOTE}>Buy only</span>
                <div style={FIELD_ROW}>
                  {PROFILE.tokens.filter((token) => token.address !== block.tokenIn).map((token) => {
                    const checked = block.tokensOut.includes(token.address);
                    return (
                      <label key={token.address} className="check" style={CHECK_ROW}>
                        <input type="checkbox" checked={checked} onChange={() => update(index, { tokensOut: checked ? block.tokensOut.filter((out) => out !== token.address) : [...block.tokensOut, token.address] })} style={CHECKBOX} />
                        {token.symbol}
                      </label>
                    );
                  })}
                </div>
                <span style={NOTE}>On these exchanges</span>
                <div style={FIELD_ROW}>
                  {PROTOCOLS.map(([id, protocol]) => {
                    const checked = block.protocols.includes(id);
                    return (
                      <label key={id} className="check" style={CHECK_ROW}>
                        <input type="checkbox" checked={checked} onChange={() => update(index, { protocols: checked ? block.protocols.filter((item) => item !== id) : [...block.protocols, id] })} style={CHECKBOX} />
                        {protocol.name}
                      </label>
                    );
                  })}
                </div>
                <span style={NOTE}>Bought tokens always go back to the company wallet; approvals are capped per transaction, never unlimited.</span>
              </>
            )}
          </div>
        ))}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={ADD_BUTTON} onClick={addTransfers} title="Send tokens to registered suppliers or the company wallet, within a budget">+ Transfers</button>
          <button style={ADD_BUTTON} onClick={addSolana} title="Send SOL or USDC on Solana to listed wallets, within a budget">+ Solana transfers</button>
          <button style={ADD_BUTTON} onClick={addNear} title="Send USDC held by the vault on NEAR to listed accounts, such as agents' spending cards">+ Pay in NEAR tokens</button>
          <button
            style={{ ...ADD_BUTTON, borderStyle: "solid", borderColor: "#C9890C", background: catalogOpen ? "#FCF0D4" : "rgba(255,255,255,.5)" }}
            onClick={() => setCatalogOpen(true)}
            title="Pick a protocol from the catalog"
          >
            + DeFi…
          </button>
          <button
            style={ADD_BUTTON}
            onClick={addShareRevenue}
            disabled={!sharesAccountId || blocks.some((block) => block.kind === "share-revenue")}
            title={sharesAccountId ? "Let the agent send ETH to the company's shareholders, within a budget" : "Issue shares first (Shares page)"}
          >
            + Share revenue
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={NOTE}>Agents holding this role</span>
          <div style={FIELD_ROW}>
            {(agents.data?.agents ?? []).filter((agent) => agent.active).map((agent) => {
              const checked = members.includes(agent.nearAccountId);
              return (
                <label key={agent.id} className="check" style={CHECK_ROW}>
                  <input type="checkbox" checked={checked} onChange={() => { setMembers((current) => checked ? current.filter((item) => item !== agent.nearAccountId) : [...current, agent.nearAccountId]); setPreview(null); }} style={CHECKBOX} />
                  {agent.name} <span className="mono" title={agent.nearAccountId} style={{ fontSize: 11.5, color: "#66718C" }}>{displayAccount(agent.nearAccountId)}</span>
                  {checked && name && agent.role !== name ? <span style={{ fontSize: 12, color: "#B54708" }}> · its requests use role "{agent.role}": name this role "{agent.role}" or update AGENT_ROLE</span> : null}
                </label>
              );
            })}
            {(agents.data?.agents ?? []).length === 0 ? <span style={NOTE}>No agent yet: you can add members later.</span> : null}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button
            className="btn-line"
            disabled={!ready || Boolean(busy)}
            onClick={() => void run("preview", async () => setPreview(await verifiedProposal(draft())))}
          >
            {busy === "preview" ? "Preparing…" : "Preview what members vote on"}
          </button>
          {!ready && missing ? <span style={NOTE}>{missing}</span> : null}
        </div>
        <p style={NOTE}>
          Then: submit to the members' vote → members approve in Decisions → the role applies after the veto window and shows up below.
        </p>

        {catalogOpen ? <DefiCatalog onPick={addSwap} onPickLending={addLending} onPickWrap={addWrap} onClose={() => setCatalogOpen(false)} /> : null}
      </Slab>

      {preview ? (
        <NightPanel style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
          <Kicker color="var(--gold)">Members will vote on</Kicker>
          <b style={{ font: "800 18px var(--font-brand)", letterSpacing: ".06em", color: "#fff" }}>{preview.title}</b>
          <div style={{ display: "flex", flexDirection: "column", borderTop: "1px solid var(--night-line)" }}>
            {preview.summary.map((item, index) => (
              <div
                key={`${item.title}-${index}`}
                style={{ display: "grid", gridTemplateColumns: "30px minmax(0, 1fr)", padding: "7px 0", borderBottom: "1px solid var(--night-line)", fontSize: 13.5, color: "#E7ECF6" }}
              >
                <b style={{ font: "700 12px var(--font-brand)", color: "var(--gold)" }}>{ROMAN[index] ?? String(index + 1)}</b>
                <span>
                  {item.title}
                  {item.details.length ? (
                    <span style={{ display: "block", marginTop: 4, color: "var(--night-text)", fontSize: 12.5 }}>
                      {item.details.map((detail) => detail.replace(/^ {2}· /, "")).join(" · ")}
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          <span style={{ fontSize: 12.5, color: "var(--aegean-link)" }}>✓ Checked in your browser: the proposal prepared by Euthyna is exactly this role.</span>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--night-text)" }}>Submitting locks a 0.1 NEAR proposal bond, returned when the proposal passes.</span>
            <button
              className="btn-ori"
              style={{ marginLeft: "auto", whiteSpace: "nowrap" }}
              disabled={!wallets.nearAccountId || Boolean(busy)}
              title={wallets.nearAccountId ? "Sign the proposal with your NEAR wallet" : "Connect your NEAR wallet first"}
              onClick={() => void run("submit", async () => {
                await signDaoProposal(wallets.nearAccountId, preview);
                navigate("/governance");
              })}
            >
              {busy === "submit" ? "Signing…" : "SUBMIT TO THE MEMBERS' VOTE"}
            </button>
          </div>
        </NightPanel>
      ) : null}
    </div>
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
    <div role="presentation" onClick={onClose} style={{ border: "1px solid rgba(13,23,48,.14)", background: "rgba(255,255,255,.5)", padding: "12px 14px" }}>
      <div role="dialog" aria-modal="true" aria-label="DeFi catalog" onClick={(event) => event.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <b style={{ font: "800 13px var(--font-brand)", letterSpacing: ".12em" }}>DEFI CATALOG</b>
            <p style={{ ...NOTE, marginTop: 4 }}>What the agent may do on each protocol. Everything else stays refused by the vault.</p>
          </div>
          <button onClick={onClose} aria-label="Close" style={PLAIN_BUTTON}>✕</button>
        </div>
        <div className="g4" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
          {DEFI_CATALOG.map((item) => {
            const available = Boolean(item.wrap || item.protocol || (item.lending && PROFILE.lending?.[item.lending]));
            return (
              <button
                key={item.id}
                disabled={!available}
                onClick={() => (item.wrap ? onPickWrap() : item.protocol ? onPick(item.protocol) : item.lending ? onPickLending(item.lending) : undefined)}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, textAlign: "left",
                  padding: "10px 12px", border: "1px solid rgba(13,23,48,.14)", background: "rgba(255,255,255,.5)", color: "#0D1730",
                  boxShadow: available ? "inset 0 0 0 2px #C9890C" : "none", cursor: available ? "pointer" : "not-allowed",
                }}
              >
                <b style={{ font: "800 12px var(--font-brand)", letterSpacing: ".12em" }}>{item.name.toUpperCase()}</b>
                <span style={{ fontWeight: 700, color: "var(--gold-ink)", fontSize: 11.5 }}>{item.action}</span>
                <span style={{ fontSize: 11.5, color: "#4A5675", lineHeight: 1.35 }}>{item.note}</span>
                {!available ? (
                  <span style={{ fontSize: 11, padding: "2px 8px", border: "1px solid rgba(13,23,48,.2)", color: "#66718C" }}>Soon</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The agent's spending card account, if it is an Euthyna agent. */
function cardOf(agentAccountId: string): string | null {
  try { return cardAccountIdOf(agentAccountId); } catch { return null; }
}

function NearReceiver({ onAdd }: { onAdd: (receiver: { accountId: string; label: string }) => void }) {
  const [accountId, setAccountId] = useState("");
  const [label, setLabel] = useState("");
  const valid = validNearAccountId(accountId) && label.trim().length > 0;
  return (
    <div style={FIELD_ROW}>
      <input placeholder="Name" value={label} onChange={(event) => setLabel(event.target.value)} style={{ ...SUB_INPUT, font: "12px var(--font-ui)" }} />
      <input className="mono" placeholder="NEAR account (bob.testnet)" value={accountId} onChange={(event) => setAccountId(event.target.value.trim().toLowerCase())} style={SUB_INPUT} />
      <button style={MINI_BUTTON} disabled={!valid} onClick={() => { onAdd({ accountId, label: label.trim() }); setAccountId(""); setLabel(""); }}>Add</button>
      {accountId && !validNearAccountId(accountId) ? <span style={{ fontSize: 12, color: "#B8442B" }}>Not a NEAR account id.</span> : null}
    </div>
  );
}

function SolanaRecipient({ onAdd }: { onAdd: (recipient: { address: string; label: string }) => void }) {
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const valid = isSolanaAddress(address) && label.trim().length > 0;
  return (
    <div style={FIELD_ROW}>
      <input placeholder="Name" value={label} onChange={(event) => setLabel(event.target.value)} style={{ ...SUB_INPUT, font: "12px var(--font-ui)" }} />
      <input className="mono" placeholder="Solana address (base58)" value={address} onChange={(event) => setAddress(event.target.value.trim())} style={SUB_INPUT} />
      <button style={MINI_BUTTON} disabled={!valid} onClick={() => { onAdd({ address, label: label.trim() }); setAddress(""); setLabel(""); }}>Add</button>
      {address && !isSolanaAddress(address) ? <span style={{ fontSize: 12, color: "#B8442B" }}>Not a Solana address.</span> : null}
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
    <div style={FIELD_ROW}>
      <input placeholder="Name" value={label} onChange={(event) => setLabel(event.target.value)} style={{ ...SUB_INPUT, font: "12px var(--font-ui)" }} />
      <input placeholder="0x… address" value={address} onChange={(event) => setAddress(event.target.value.trim())} style={SUB_INPUT} />
      <button style={MINI_BUTTON} disabled={!valid || busy} onClick={() => void (async () => {
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
      {error ? <span style={{ fontSize: 12, color: "#B54708" }}>{error}</span> : null}
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
