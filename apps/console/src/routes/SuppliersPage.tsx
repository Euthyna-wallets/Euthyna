import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import { bytesToHex, hexToBytes } from "viem";
import { payeeVote, RAILS, readPayee, type RailId, type ReadPayee } from "@euthyna/sdk/bank-private";
import { decodeVaultCalls, type RuleChange } from "@euthyna/sdk/roles";
import { api } from "../api.js";
import { Kicker, NightPanel, PageTitle, Seal, Slab } from "../components/design.js";
import { PageState } from "../components/ui.js";
import { readerKey } from "../lib/reader-key.js";
import { useWallets } from "../lib/wallet-context.js";
import { bankApi, omni, type ProposalDraft } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";

type Entry = { address: number[]; label: string };
type Registry = { suppliers: Array<{ name: string; wallets: Array<{ chainId: number; address: string }> }> };

const INPUT: CSSProperties = {
  background: "#fff", border: "1px solid rgba(13,23,48,.2)", borderRadius: 2, padding: "10px 12px",
  font: "13px var(--font-ui)", color: "var(--ink)", width: "100%", boxSizing: "border-box", minWidth: 0,
};
const STELE: CSSProperties = {
  backgroundColor: "#FBF9F4",
  backgroundImage: "linear-gradient(115deg, rgba(255,255,255,.7), rgba(255,255,255,.3) 45%, rgba(13,23,48,.08)), url(/media/textures/marble-white.jpg)",
  backgroundSize: "cover, cover",
  borderRadius: "220px 220px 2px 2px",
  boxShadow: "26px 30px 60px rgba(13,23,48,.25), inset 0 0 0 1px rgba(13,23,48,.08), inset 0 0 0 10px rgba(255,255,255,.35)",
  padding: "70px 44px 34px", minHeight: 540, display: "flex", flexDirection: "column", gap: 6, boxSizing: "border-box",
};

export function SuppliersPage() {
  const wallets = useWallets();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["chain-suppliers"], queryFn: () => api<{ entries: Entry[] }>("/v1/console/omniroles/suppliers"), refetchInterval: 10_000 });
  const governance = useQuery({ queryKey: ["omni-governance"], queryFn: omni.governance, refetchInterval: 10_000 });
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status });
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const bank = useQuery({ queryKey: ["bank-policy"], queryFn: bankApi.policy, refetchInterval: 10_000 });
  const rails = useQuery({ queryKey: ["bank-rails"], queryFn: bankApi.rails, staleTime: 300_000 });
  const [rail, setRail] = useState<RailId>("sepa");
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState("");
  const [opened, setOpened] = useState<Record<number, ReadPayee | null>>({});
  const railSpec = RAILS.find((item) => item.id === rail)!;
  const channelId = rails.data?.rails.find((item) => item.id === rail)?.channelId ?? null;
  const beneficiary = useMutation({
    mutationFn: async (remove: number | null) => {
      const treasury = status.data?.treasury;
      const policy = bank.data;
      if (!treasury || !wallets.nearAccountId || !policy) throw new Error("Connect your NEAR wallet and load the treasury first");
      let expected: RuleChange;
      let draft: ProposalDraft;
      if (remove !== null) {
        expected = { RemoveSealedBankBeneficiary: { id: remove } };
        draft = await bankApi.beneficiaryProposal({ remove });
      } else {
        // Sealed here, in this browser: the server and the chain get a commitment and two envelopes.
        if (!policy.boxKey) throw new Error("Euro payouts are not enabled yet: the members vote the bank signer first (Treasury → Euro payouts).");
        if (!policy.readers?.length) throw new Error("No member has a reading key yet: register yours (Treasury → Sealed orders) so the members can read the IBANs they vote.");
        if (!channelId) throw new Error("The bank partner offers no payout channel for this country right now.");
        const vote = await payeeVote({ vault: treasury.vaultAccountId, rail, channelId, values, boxKeyHex: policy.boxKey, readers: policy.readers });
        expected = { AddSealedBankBeneficiary: { label: label.trim(), commitment: vote.commitment, sealed_for_signer: vote.sealedForSigner, sealed_for_members: vote.sealedForMembers } };
        draft = await bankApi.beneficiaryProposal({ label: label.trim(), commitment: vote.commitment, sealedForSigner: vote.sealedForSigner, sealedForMembers: vote.sealedForMembers });
      }
      const decoded = decodeVaultCalls(draft.args.proposal.kind as Parameters<typeof decodeVaultCalls>[0], treasury.vaultAccountId);
      if (draft.receiverId !== treasury.daoAccountId || JSON.stringify(decoded) !== JSON.stringify([{ method: "queue_rule_change", change: expected }])) throw new Error("Beneficiary proposal does not match what was typed in this browser");
      await signDaoProposal(wallets.nearAccountId, draft);
      setValues({});
      setLabel("");
    },
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["omni-governance"] }); },
  });
  const request = useMutation({
    mutationFn: async (migrate: boolean) => {
      const treasury = status.data?.treasury;
      if (!treasury || !wallets.nearAccountId) throw new Error("Connect your NEAR wallet and load the treasury first");
      let entries = [{ address: address.trim(), label: name.trim() }];
      if (migrate) {
        const registry = await api<Registry>("/v1/console/registry");
        entries = [...new Map(registry.suppliers.flatMap((s) => s.wallets.filter((w) => w.chainId === treasury.chainId).map((w) => [w.address.toLowerCase(), { address: w.address, label: s.name }] as const))).values()];
      }
      let expected: RuleChange[] = entries.map((e) => ({ AddListAddress: { list: "suppliers", address: Array.from(hexToBytes(e.address as `0x${string}`)), label: e.label } }));
      if (migrate) expected = [{ AddListAddresses: { list: "suppliers", entries: entries.map((e) => ({address:Array.from(hexToBytes(e.address as `0x${string}`)),label:e.label})) } }];
      const draft = await api<ProposalDraft>("/v1/console/omniroles/proposals/suppliers", { method: "POST", body: JSON.stringify({ entries, migrate }) });
      const decoded = decodeVaultCalls(draft.args.proposal.kind as Parameters<typeof decodeVaultCalls>[0], treasury.vaultAccountId);
      const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
      if (draft.receiverId !== treasury.daoAccountId || canonical(decoded) !== canonical(expected.map((change) => ({ method: "queue_rule_change", change })))) throw new Error("Supplier proposal does not match the addresses selected in this browser");
      await signDaoProposal(wallets.nearAccountId, draft);
    },
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["omni-governance"] }); },
  });
  const pending = governance.data?.rules.filter((r) => r.state === "Queued" && /suppliers|beneficiar|euro payouts/i.test(r.title)) ?? [];
  const proposals = governance.data?.proposals.filter((p) => p.status === "InProgress" && /supplier|beneficiar/i.test(p.title)) ?? [];
  const beneficiaries = bank.data?.beneficiaries ?? [];
  const unlock = useMutation({
    mutationFn: async () => {
      const treasury = status.data?.treasury;
      if (!treasury || !wallets.nearAccountId) throw new Error("Connect your NEAR wallet first");
      const key = await readerKey(treasury.vaultAccountId);
      const result: Record<number, ReadPayee | null> = {};
      for (const entry of beneficiaries) {
        result[entry.id] = await readPayee(entry.sealedForMembers, entry.commitment, wallets.nearAccountId, key.privateKey).catch(() => null);
      }
      setOpened(result);
    },
  });
  const chainName = status.data?.treasury?.chainName;
  const entries = query.data?.entries ?? [];
  const supplierRows = entries.map((entry) => ({ entry, hex: bytesToHex(Uint8Array.from(entry.address)) }));
  const supplierVotes = new Map<string, { id: number; at: string }>();
  for (const proposal of governance.data?.proposals ?? []) {
    for (const change of proposal.changes) {
      if (!change.title.toLowerCase().includes("suppliers")) continue;
      for (const row of supplierRows) {
        if (!supplierVotes.has(row.hex) && change.details.some((detail) => detail.toLowerCase().includes(row.hex.toLowerCase()))) {
          supplierVotes.set(row.hex, { id: proposal.id, at: proposal.submittedAt });
        }
      }
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 6, margin: 0 }}>
        <span style={{ font: "600 12px var(--font-ui)", color: "#66718C" }}>Settings · suppliers</span>
        <PageTitle>SUPPLIERS</PageTitle>
        <p style={{ margin: 0, fontSize: 14, color: "#4A5675", maxWidth: 820 }}>
          Recipients in the vault’s suppliers list. DAO approval and the veto window apply to every change.
        </p>
      </header>

      <PageState loading={query.isLoading} error={query.error} empty={false}>
        <div className="g2" style={{ display: "grid", gridTemplateColumns: "460px minmax(0, 1fr)", gap: 32, alignItems: "start" }}>
          <section style={STELE}>
            <Kicker style={{ textAlign: "center" }}>On chain · in the vault</Kicker>
            <h2 className="page-title" style={{ margin: "4px 0 18px", textAlign: "center", fontSize: 30, letterSpacing: ".16em" }}>THE SUPPLIERS</h2>
            {supplierRows.length ? supplierRows.map(({ entry, hex }) => {
              const vote = supplierVotes.get(hex);
              return (
                <div key={hex} style={{ display: "grid", gridTemplateColumns: "44px minmax(0, 1fr)", gap: 14, alignItems: "center", padding: "14px 0", borderTop: "1px solid rgba(13,23,48,.14)" }}>
                  <Seal word="VOTED" size={40} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                    <b style={{ font: "900 20px var(--font-brand)", letterSpacing: ".14em", color: "var(--carved)", textShadow: "var(--carved-shadow)", overflowWrap: "anywhere" }}>{entry.label.toUpperCase()}</b>
                    <span style={{ font: "12.5px var(--font-mono)", color: "#4A5675", overflowWrap: "anywhere" }}>
                      {hex}{chainName ? ` · ${chainName}` : ""}
                    </span>
                    <span style={{ fontSize: 11.5, color: "#66718C" }}>
                      {vote ? `Proposal #${vote.id} · ${new Date(vote.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "Added by a DAO vote"}
                    </span>
                  </div>
                </div>
              );
            }) : (
              <p className="empty-state" style={{ textAlign: "center", margin: "24px 0" }}>No supplier on chain yet.</p>
            )}
            {beneficiaries.length ? (
              <div style={{ display: "flex", justifyContent: "center", paddingTop: 12 }}>
                <button className="btn-line" style={{ fontSize: 10 }} disabled={unlock.isPending} onClick={() => unlock.mutate()}>
                  {unlock.isPending ? "SIGNING…" : "READ THE SEALED IBANS"}
                </button>
              </div>
            ) : null}
            {beneficiaries.map((entry) => {
              const open = opened[entry.id];
              return (
                <div key={entry.id} style={{ display: "grid", gridTemplateColumns: "44px minmax(0, 1fr) auto", gap: 14, alignItems: "center", padding: "14px 0", borderTop: "1px solid rgba(13,23,48,.14)" }}>
                  <Seal word="VOTED" size={40} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                    <b style={{ font: "900 20px var(--font-brand)", letterSpacing: ".14em", color: "var(--carved)", textShadow: "var(--carved-shadow)", overflowWrap: "anywhere" }}>
                      {open ? open.name.toUpperCase() : `BENEFICIARY #${entry.id}${entry.label ? ` · ${entry.label.toUpperCase()}` : ""}`}
                    </b>
                    <span style={{ font: "12.5px var(--font-mono)", color: "#4A5675", overflowWrap: "anywhere" }}>
                      {open ? `${open.account} · ${open.currency} · ${RAILS.find((item) => item.id === open.rail)?.title ?? open.rail}` : `sealed · ${entry.commitment.slice(0, 16)}…`}
                    </span>
                    <span style={{ fontSize: 11.5, color: "#66718C" }}>
                      {open ? "Read in this browser only" : open === null ? "Not sealed for your reading key." : "Account sealed: not on chain, readable by the members only."}
                    </span>
                  </div>
                  <button className="btn-line" style={{ fontSize: 10 }} disabled={beneficiary.isPending} onClick={() => beneficiary.mutate(entry.id)} title="Propose removing this beneficiary">REMOVE</button>
                </div>
              );
            })}
            <span style={{ marginTop: "auto", paddingTop: 18, fontSize: 12.5, color: "#66718C", textAlign: "center" }}>Read from the vault, not from our servers.</span>
          </section>

          <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
            <Slab style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
              <Kicker>Add supplier</Kicker>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <input maxLength={64} aria-label="Supplier name" placeholder="Supplier name" value={name} onChange={(e) => setName(e.target.value)} style={{ ...INPUT, flex: "0 0 180px" }} />
                <input aria-label="Recipient address" placeholder="0x… recipient" value={address} onChange={(e) => setAddress(e.target.value)} style={{ ...INPUT, flex: "1 1 220px", fontFamily: "var(--font-mono)" }} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12.5, color: "#66718C" }}>Members vote on it, then the veto window runs. Agents never add a supplier.</span>
                <button
                  className="btn-ori"
                  style={{ marginLeft: "auto", whiteSpace: "nowrap" }}
                  disabled={request.isPending || !name.trim() || !/^0x[0-9a-fA-F]{40}$/.test(address.trim())}
                  onClick={() => request.mutate(false)}
                >
                  {request.isPending ? "SIGNING…" : "ADD SUPPLIER"}
                </button>
              </div>
              <button
                className="btn-line"
                style={{ alignSelf: "flex-start" }}
                disabled={request.isPending || Boolean(entries.length)}
                onClick={() => request.mutate(true)}
              >
                MOVE EXISTING SUPPLIERS ON CHAIN
              </button>
              {request.error ? (
                <p role="alert" style={{ margin: 0, padding: "10px 12px", background: "#FBE3D6", border: "1px solid rgba(168,56,30,.35)", color: "var(--terra-ink)", fontSize: 13 }}>
                  {request.error.message}
                </p>
              ) : null}
            </Slab>

            {bank.data?.supported ? (
              <Slab style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
                <Kicker>Add a bank beneficiary · payroll, suppliers, abroad</Kicker>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <select aria-label="Country and rail" value={rail} onChange={(e) => { setRail(e.target.value as RailId); setValues({}); }} style={{ ...INPUT, flex: "0 0 240px" }}>
                    {RAILS.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.currency}</option>)}
                  </select>
                  <input maxLength={32} aria-label="Public label" placeholder="Public label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} style={{ ...INPUT, flex: "0 0 180px" }} />
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {railSpec.fields.map((field) => field.options ? (
                    <select key={field.key} aria-label={field.label} value={values[field.key] ?? field.options[0]![0]} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })} style={{ ...INPUT, flex: "0 0 150px" }}>
                      {field.options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                    </select>
                  ) : (
                    <input key={field.key} aria-label={field.label} placeholder={field.placeholder ?? field.label} value={values[field.key] ?? ""} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })} style={{ ...INPUT, flex: "1 1 160px", fontFamily: /iban|account|routing|sort|pix/i.test(field.key) ? "var(--font-mono)" : undefined }} />
                  ))}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, color: "#66718C" }}>
                    Sealed in this browser: the chain and our servers get a commitment, never the account or the name. The label is public, so never a name.
                    Paid in {railSpec.currency} from the company's euros{channelId ? "" : " (no channel from the bank partner right now)"}; the enclave pays no other account.
                  </span>
                  <button
                    className="btn-ori"
                    style={{ marginLeft: "auto", whiteSpace: "nowrap" }}
                    disabled={beneficiary.isPending || !channelId}
                    onClick={() => beneficiary.mutate(null)}
                    title={bank.data?.boxKey ? "" : "Enable euro payouts first"}
                  >
                    {beneficiary.isPending ? "SIGNING…" : "ADD BENEFICIARY"}
                  </button>
                </div>
                {unlock.error ? <span style={{ fontSize: 12, color: "var(--terra-ink)" }}>{unlock.error.message}</span> : null}
                {beneficiary.error ? (
                  <p role="alert" style={{ margin: 0, padding: "10px 12px", background: "#FBE3D6", border: "1px solid rgba(168,56,30,.35)", color: "var(--terra-ink)", fontSize: 13 }}>
                    {beneficiary.error.message}
                  </p>
                ) : null}
              </Slab>
            ) : null}

            <Slab style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
              <Kicker>Pending changes</Kicker>
              {proposals.map((proposal) => (
                <div key={proposal.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 0", borderTop: "1px solid rgba(13,23,48,.1)", fontSize: 13.5 }}>
                  <Seal word="PENDING" size={32} />
                  <span>{proposal.title}: waiting for DAO votes</span>
                </div>
              ))}
              {pending.map((rule) => (
                <div key={rule.queueId} style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 0", borderTop: "1px solid rgba(13,23,48,.1)", fontSize: 13.5 }}>
                  <Seal word="QUEUED" size={32} />
                  <span>{rule.title}: applies at {new Date(rule.activatesAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} unless a council member vetoes it</span>
                </div>
              ))}
              {!pending.length && !proposals.length ? <span style={{ fontSize: 13.5, color: "#4A5675" }}>No pending changes.</span> : null}
            </Slab>

            <NightPanel style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
              <Kicker color="#F2B544">Why the list matters</Kicker>
              <span style={{ fontSize: 14, color: "#C9D3EA", lineHeight: 1.55 }}>
                A role can say: <i>transfer USDC only to a supplier on the vault’s list</i>. When an agent asks to pay any other address, the vault refuses before anything is signed, and the refusal shows in Activity.
              </span>
              <span style={{ fontSize: 12.5, color: "#A9B6D6" }}>To pay it anyway, members vote on that exact transaction once, or add the address here for good.</span>
            </NightPanel>
          </div>
        </div>
      </PageState>
    </div>
  );
}
