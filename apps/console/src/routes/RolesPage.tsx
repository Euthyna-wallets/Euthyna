import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getAddress } from "viem";
import { BASE_SEPOLIA, budgetsOf, compileRole, decodeVaultCalls, describeVaultCall, validRoleName, type ProtocolId, type RoleBlock, type RoleDraft } from "@mandateos/sdk/roles";

import { api, type AgentRow } from "../api.js";
import { Card, PageState, Status, short } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type ProposalDraft, type RoleView } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";
import { SentenceList } from "./GovernancePage.js";

type Registry = { suppliers: Array<{ id: string; name: string; wallets: Array<{ chainId: number; address: string }> }> };

const PROFILE = BASE_SEPOLIA;
const PROTOCOLS = Object.entries(PROFILE.protocols) as Array<[ProtocolId, { name: string; router: string }]>;

export function RolesPage() {
  const roles = useQuery({ queryKey: ["omni-roles"], queryFn: omni.roles, refetchInterval: 15_000 });
  const [params, setParams] = useSearchParams();
  const [building, setBuilding] = useState(params.get("new") === "1");
  const suggested = params.get("role") ?? "";
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Roles</h1>
          <p className="muted">
            A role is what an agent may do with company funds: which contracts, which counterparties, which budget.
            Everything else is refused by the vault.
          </p>
        </div>
        {!building ? <button className="primary" onClick={() => setBuilding(true)}>New role</button> : null}
      </header>
      {building ? <RoleBuilder initialName={suggested} onClose={() => { setBuilding(false); setParams({}); }} /> : null}
      <PageState
        loading={roles.isLoading}
        error={roles.error}
        empty={roles.data?.roles.length === 0}
        emptyContent={building ? null : (
          <div className="state empty-action">
            <span>No role yet. Create one, the members vote on it, and it applies after the veto window.</span>
            <button className="primary" onClick={() => setBuilding(true)}>Create the first role</button>
          </div>
        )}
      >
        {(roles.data?.roles ?? []).map((role) => <RoleCard key={role.name} role={role} />)}
      </PageState>
    </div>
  );
}

function RoleCard({ role }: { role: RoleView }) {
  return (
    <Card title={`Role "${role.name}"`} action={<Status value={role.enabled ? "active" : "disabled"} />}>
      <div className="role-grid">
        <div>
          <h3>Budgets</h3>
          {role.budgets.length === 0 ? <p className="muted small">No budget: this role cannot move value.</p> : role.budgets.map((budget) => {
            const available = Number(budget.available ?? 0);
            const max = Number(budget.max ?? 0);
            const used = max > 0 ? Math.min(100, Math.round(((max - available) / max) * 100)) : 0;
            return (
              <div key={budget.key} className="budget">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span>{budget.label}</span>
                  <span className="small">{available.toLocaleString()} / {max.toLocaleString()} {budget.token ?? ""} left</span>
                </div>
                <div className="bar"><span style={{ width: `${used}%` }} /></div>
                <span className="small muted">Refilled every {budget.periodDays ?? "?"} days</span>
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
  | { kind: "swap"; tokenIn: string; tokensOut: string[]; protocols: ProtocolId[]; amount: string; periodDays: number; maxApproval: string };

const tokenSymbol = (address: string) => PROFILE.tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())?.symbol ?? short(address);

function RoleBuilder({ onClose, initialName = "" }: { onClose: () => void; initialName?: string }) {
  const wallets = useWallets();
  const navigate = useNavigate();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ agents: AgentRow[] }>("/v1/console/agents") });
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status });
  const registry = useQuery({ queryKey: ["registry"], queryFn: () => api<Registry>("/v1/console/registry") });
  const [name, setName] = useState(initialName);
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

  const defaultToken = PROFILE.tokens[0]!.address;
  const supplierOptions = (registry.data?.suppliers ?? []).flatMap((supplier) =>
    supplier.wallets.filter((wallet) => wallet.chainId === PROFILE.chainId).map((wallet) => ({ address: wallet.address, label: supplier.name })));

  const update = (index: number, patch: Partial<BlockDraft>) => {
    setPreview(null);
    setBlocks((current) => current.map((block, position) => (position === index ? ({ ...block, ...patch } as BlockDraft) : block)));
  };

  const draft = (): RoleDraft => ({
    name,
    blocks: blocks.map((block): RoleBlock => block.kind === "payments"
      ? { kind: "payments", token: block.token as `0x${string}`, recipients: block.recipients.map((item) => ({ address: item.address as `0x${string}`, label: item.label })), budget: { amount: block.amount, periodDays: block.periodDays } }
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
    Number(block.amount) > 0 && (block.kind === "payments" ? block.recipients.length > 0 : block.tokensOut.length > 0 && block.protocols.length > 0 && Number(block.maxApproval) > 0));

  return (
    <Card title="New role" action={<button className="ghost" onClick={onClose}>Cancel</button>}>
      {error ? <div className="alert error">{error}</div> : null}
      <div className="stack">
        <label>
          Role name
          <input placeholder="treasury" value={name} onChange={(event) => { setName(event.target.value.toLowerCase()); setPreview(null); }} />
          {name && !validRoleName(name) ? <span className="small" style={{ color: "#b42318" }}>Lowercase letters, digits and dashes, 2 to 32 characters.</span> : null}
        </label>

        {blocks.map((block, index) => (
          <div className="block" key={index}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{block.kind === "payments" ? "Pay suppliers" : "Swap tokens"}</strong>
              <button className="ghost" onClick={() => { setBlocks((current) => current.filter((_, position) => position !== index)); setPreview(null); }}>Remove</button>
            </div>
            {block.kind === "payments" ? (
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
          <button onClick={() => { setBlocks((current) => [...current, { kind: "payments", token: defaultToken, recipients: [], amount: "1000", periodDays: 30 }]); setPreview(null); }}>+ Pay suppliers</button>
          <button onClick={() => { setBlocks((current) => [...current, { kind: "swap", tokenIn: defaultToken, tokensOut: [], protocols: ["uniswap-v3"], amount: "10000", periodDays: 30, maxApproval: "1000" }]); setPreview(null); }}>+ Swap tokens</button>
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
        </div>

        {preview ? (
          <div className="decision">
            <header><div><span className="eyebrow">Members will vote on</span><h3>{preview.title}</h3></div></header>
            <SentenceList items={preview.summary} />
            <p className="small muted verified">✓ Checked in your browser: the proposal prepared by MandateOS is exactly this role.</p>
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
