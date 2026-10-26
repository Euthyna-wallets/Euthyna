import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { bytesToHex, hexToBytes } from "viem";
import { decodeVaultCalls, type RuleChange } from "@mandateos/sdk/roles";
import { api } from "../api.js";
import { Card, PageState } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type ProposalDraft } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";

type Entry = { address: number[]; label: string };
type Registry = { suppliers: Array<{ name: string; wallets: Array<{ chainId: number; address: string }> }> };
export function SuppliersPage() {
  const wallets = useWallets();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["chain-suppliers"], queryFn: () => api<{ entries: Entry[] }>("/v1/console/omniroles/suppliers"), refetchInterval: 10_000 });
  const governance = useQuery({ queryKey: ["omni-governance"], queryFn: omni.governance, refetchInterval: 10_000 });
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status });
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
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
  const pending = governance.data?.rules.filter((r) => r.state === "Queued" && /suppliers/.test(r.title)) ?? [];
  const proposals = governance.data?.proposals.filter((p) => p.status === "InProgress" && /supplier/i.test(p.title)) ?? [];
  return <div className="page"><header className="page-head"><div><h1>Suppliers</h1><p className="muted">Recipients in the vault's suppliers list. DAO approval and the veto window apply to every change.</p></div></header>
    <PageState loading={query.isLoading} error={query.error} empty={false}>
      <Card title="On-chain suppliers"><table><thead><tr><th>Name</th><th>Address</th></tr></thead><tbody>{query.data?.entries.map((e) => <tr key={bytesToHex(Uint8Array.from(e.address))}><td>{e.label}</td><td className="mono small">{bytesToHex(Uint8Array.from(e.address))}</td></tr>)}</tbody></table></Card>
      <Card title="Pending changes">{proposals.map((p) => <p key={p.id}>{p.title}: waiting for DAO votes</p>)}{pending.map((p) => <p key={p.queueId}>{p.title}: activates {p.activatesAt}</p>)}{!pending.length && !proposals.length ? <p>No pending changes.</p> : null}</Card>
      <Card title="Add supplier"><div className="row wrap"><input maxLength={64} placeholder="Supplier name" value={name} onChange={(e) => setName(e.target.value)} /><input placeholder="0x… recipient" value={address} onChange={(e) => setAddress(e.target.value)} /><button disabled={request.isPending || !name.trim() || !/^0x[0-9a-fA-F]{40}$/.test(address.trim())} onClick={() => request.mutate(false)}>Add supplier</button></div>
      <button disabled={request.isPending || Boolean(query.data?.entries.length)} onClick={() => request.mutate(true)}>Move existing suppliers on chain</button>{request.error ? <p className="alert error">{request.error.message}</p> : null}</Card>
    </PageState></div>;
}
