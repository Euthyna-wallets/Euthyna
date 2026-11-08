import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Kicker, Seal, SectionHead, Slab } from "../components/design.js";
import { useWallets } from "../lib/wallet-context.js";
import { bankApi, omni, type BankBusiness, type ProposalDraft } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";

const ENTITY_TYPES: Array<[string, string]> = [
  ["LimitedLiabilityCompany", "Limited liability company"], ["Corporation", "Corporation"], ["PublicCompany", "Public company"],
  ["Partnership", "Partnership"], ["SoleProprietorship", "Sole proprietorship"], ["NonProfitOrganization", "Non-profit"],
  ["Charity", "Charity"], ["Trust", "Trust"], ["PrivateFoundation", "Private foundation"], ["PublicAgency", "Public agency"],
];

const ROW = { display: "grid", gridTemplateColumns: "120px minmax(0, 1fr) auto", gap: 12, alignItems: "center", padding: "9px 0", borderTop: "1px solid rgba(13,23,48,.12)", fontSize: 13 } as const;
const LABEL = { font: "700 11px var(--font-brand)", letterSpacing: ".14em", textTransform: "uppercase", color: "var(--ink-3)" } as const;

const NETWORKS: Record<string, string> = { BaseTestSepolia: "Base Sepolia", Base: "Base" };

/** "MT49CFTE1987…" → "MT49 CFTE 1987 …". */
const groupIban = (iban: string) => iban.replace(/(.{4})/g, "$1 ").trim();

/**
 * The company's euro account (Noah): a SEPA transfer to its IBAN arrives as EURC in the company
 * wallet, and from there it moves only as the roles allow or the members vote.
 */
export function BankAccountCard() {
  const queryClient = useQueryClient();
  const bank = useQuery({ queryKey: ["bank"], queryFn: bankApi.view, refetchInterval: (query) => (query.state.data?.account ? 15_000 : false) });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("25");
  const [form, setForm] = useState<BankBusiness>({
    registeredName: "", registrationNumber: "", entityType: "LimitedLiabilityCompany", country: "FR", street: "", city: "",
    postCode: "", state: "", incorporationDate: "", taxId: "",
  });
  if (!bank.data?.configured) return null;
  const account = bank.data.account;

  const run = (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    void action().then(setMessage, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => { setBusy(false); void queryClient.invalidateQueries({ queryKey: ["bank"] }); void queryClient.invalidateQueries({ queryKey: ["omni-holdings"] }); });
  };
  const field = (key: keyof BankBusiness, label: string, placeholder = "", type = "text") => (
    <div className="field-app">
      <label htmlFor={`bank-${key}`}>{label}</label>
      <input id={`bank-${key}`} type={type} value={form[key] ?? ""} placeholder={placeholder} disabled={busy} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
    </div>
  );
  const complete = Object.entries(form).every(([key, value]) => key === "email" || String(value).trim());

  return (
    <Slab style={{ padding: "20px 24px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHead
        left={<Kicker>Euro bank account · IBAN</Kicker>}
        right={bank.data.sandbox ? <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".14em", border: "1px solid rgba(13,23,48,.2)", padding: "3px 8px", color: "var(--ink-2)" }}>SANDBOX · NOAH</span> : null}
      />
      <span style={{ fontSize: 13, lineHeight: 1.55, color: "var(--ink-2)" }}>
        Clients and investors pay the company by SEPA transfer. The euros arrive as <b>EURC</b> in the company wallet, the only
        address this account can pay into. From there, money moves only as a role allows or the members vote.
      </span>

      {bank.isLoading ? <div className="loading-slab" /> : account ? (
        <>
          <div style={ROW}><b style={LABEL}>IBAN</b><span className="mono" style={{ fontSize: 14, color: "var(--ink)", overflowWrap: "anywhere" }}>{groupIban(account.iban)}</span>
            <button className="btn" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => void navigator.clipboard.writeText(account.iban)}>Copy</button></div>
          <div style={ROW}><b style={LABEL}>BIC</b><span className="mono">{account.bic}</span><span /></div>
          <div style={ROW}><b style={LABEL}>Holder</b><span>{account.accountHolder}</span><span /></div>
          <div style={ROW}><b style={LABEL}>Bank</b><span>{account.bankName}</span><span /></div>
          <div style={ROW}><b style={LABEL}>Settles</b><span>as {account.settlesAs.replace(/_TEST$/, "")} into <span className="mono">{account.destinationAddress.slice(0, 6)}…{account.destinationAddress.slice(-4)}</span> on {NETWORKS[account.network] ?? account.network}</span><span /></div>

          {bank.data.sandbox ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 0 4px", borderTop: "1px solid rgba(13,23,48,.12)" }}>
              <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Sandbox: send a SEPA transfer of</span>
              <input aria-label="Amount in EUR" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy}
                style={{ width: 90, padding: "8px 10px", border: "1px solid rgba(13,23,48,.2)", font: "14px var(--font-mono)" }} />
              <span style={{ fontSize: 13, color: "var(--ink-2)" }}>EUR</span>
              <button type="button" className="btn-ori" style={{ padding: "10px 16px" }} disabled={busy || !/^\d{1,4}(\.\d{1,2})?$/.test(amount)}
                onClick={() => run(async () => { await bankApi.simulate(amount); return `Transfer of ${amount} EUR sent. The EURC reaches the company wallet in about a minute.`; })}>
                {busy ? "SENDING…" : "SIMULATE A TRANSFER"}
              </button>
            </div>
          ) : null}

          <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
            <b style={{ ...LABEL, padding: "8px 0 4px" }}>Transfers</b>
            {(bank.data.transfers ?? []).length === 0 ? (
              <span style={{ fontSize: 13, color: "var(--ink-3)", padding: "4px 0" }}>Nothing received yet.</span>
            ) : (bank.data.transfers ?? []).slice(0, 8).map((transfer) => (
              <div key={transfer.id} style={{ ...ROW, gridTemplateColumns: "150px minmax(0, 1fr) auto" }}>
                <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{new Date(transfer.created).toLocaleString()}</span>
                <span>{transfer.direction === "in" ? "SEPA received, converted" : "Paid into the company wallet"} · <b className="mono">{transfer.amount} {transfer.currency.replace(/_TEST$/, "")}</b> · {transfer.status}</span>
                {transfer.explorer ? <a href={transfer.explorer} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "var(--aegean-ink)" }}>tx ↗</a> : <span />}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 6 }}>
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
            Open the account with the company's legal details (KYB). An owner of the company does it once.
            {bank.data.sandbox ? " Sandbox: test details are fine; nothing real moves." : ""}
          </span>
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
            {field("registeredName", "Registered name", "Acme AI SAS")}
            {field("registrationNumber", "Registration number", "SIREN, company number…")}
            <div className="field-app">
              <label htmlFor="bank-entityType">Entity type</label>
              <select id="bank-entityType" value={form.entityType} disabled={busy} onChange={(event) => setForm({ ...form, entityType: event.target.value })}>
                {ENTITY_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            {field("taxId", "Tax ID", "VAT or tax number")}
            {field("incorporationDate", "Incorporation date", "", "date")}
            {field("country", "Country (ISO code)", "FR")}
            {field("street", "Street", "1 Rue …")}
            {field("city", "City")}
            {field("postCode", "Post code")}
            {field("state", "Region or state")}
          </div>
          <button type="button" className="btn-ori" style={{ alignSelf: "flex-start" }} disabled={busy || !complete}
            onClick={() => run(async () => { await bankApi.open({ ...form, country: form.country.trim().toUpperCase() }); return "Euro account opened: the IBAN settles into the company wallet."; })}>
            {busy ? "OPENING…" : "OPEN THE EURO ACCOUNT"}
          </button>
        </div>
      )}
      {message ? <p role="status" style={{ margin: "4px 0 0", fontSize: 13, color: "var(--aegean-ink)" }}>{message}</p> : null}
      {error ? <div role="alert" style={{ border: "1px solid rgba(217,87,59,.55)", background: "rgba(217,87,59,.08)", padding: "10px 12px", fontSize: 13, color: "var(--terra-ink)" }}>{error}</div> : null}
    </Slab>
  );
}

const STATE_WORD: Record<string, string> = { Requested: "SIGNER", Transferring: "SENT", Failed: "REFUSED" };

/**
 * Euro payouts: agents pay voted IBANs under their role's budget. The vault's policy decides;
 * the bank signer (an enclave) only turns an approved payout into the partner's single-use rule.
 */
export function EuroPayoutsCard() {
  const wallets = useWallets();
  const client = useQueryClient();
  const policy = useQuery({ queryKey: ["bank-policy"], queryFn: bankApi.policy, refetchInterval: 15_000 });
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status });
  const [role, setRole] = useState("");
  const [budget, setBudget] = useState("");
  const [ceiling, setCeiling] = useState("500");
  const [daily, setDaily] = useState("1000");
  const sign = useMutation({
    mutationFn: async (draft: Promise<ProposalDraft>) => {
      if (!wallets.nearAccountId) throw new Error("Connect your NEAR wallet first");
      await signDaoProposal(wallets.nearAccountId, await draft);
    },
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["omni-governance"] }); },
  });
  const data = policy.data;
  if (!data || !data.supported) return null;
  const roles = data.roles;
  const chosen = roles.find((item) => item.role === role) ?? roles[0];
  const euroBudgets = chosen?.budgets.filter((item) => item.token === "EURC") ?? [];
  const chosenBudget = euroBudgets.find((item) => item.key === budget) ?? euroBudgets[0];
  const units = (text: string) => (/^\d{1,7}(\.\d{1,2})?$/.test(text) ? String(Math.round(Number(text) * 1_000_000)) : null);
  const ceilingUnits = units(ceiling);
  const dailyUnits = units(daily);
  const explorer = status.data?.treasury?.vaultAccountId ? `https://testnet.nearblocks.io/address/${status.data.treasury.vaultAccountId}` : null;

  return (
    <Slab style={{ padding: "20px 24px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHead
        left={<Kicker>Euro payouts · agents pay IBANs</Kicker>}
        right={data.config ? <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".14em", border: "1px solid rgba(13,23,48,.2)", padding: "3px 8px", color: "var(--ink-2)" }}>{data.config.configured === false ? "SIGNER OUTDATED" : "ENABLED"}</span> : null}
      />
      <span style={{ fontSize: 13, lineHeight: 1.55, color: "var(--ink-2)" }}>
        An agent pays a voted beneficiary (Settings · suppliers) within its role's euro budget. IBANs are sealed: only a commitment
        is on chain, the members read them with their reading key and only the enclave can pay them. The vault checks the beneficiary, the amount
        and the budget on chain, then a bank signer running in an enclave asks the partner for a single-use payout and the vault
        sends the EURC itself. No other IBAN can be paid.
      </span>

      {!data.config ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "10px 0 4px", borderTop: "1px solid rgba(13,23,48,.12)" }}>
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
            {data.deployable ? (data.customerId ? "Members vote once to point the vault at the bank signer." : "Open the euro account first, then members vote to enable payouts.") : "No bank signer is deployed for this console."}
          </span>
          <button className="btn-ori" style={{ marginLeft: "auto" }} disabled={!data.deployable || !data.customerId || sign.isPending} onClick={() => sign.mutate(bankApi.configProposal())}>
            {sign.isPending ? "SIGNING…" : "PROPOSE: ENABLE EURO PAYOUTS"}
          </button>
        </div>
      ) : (
        <>
          <div style={ROW}><b style={LABEL}>Signer</b><span>OutLayer enclave on <span className="mono">{data.config.outlayer_id}</span> · code <span className="mono">{data.config.signer_hash.slice(0, 12)}…</span>{data.config.configured === false ? " (this console expects a newer signer: propose again)" : ""}</span>
            {data.config.configured === false ? <button className="btn-line" style={{ fontSize: 10 }} disabled={sign.isPending} onClick={() => sign.mutate(bankApi.configProposal())}>UPDATE</button> : <span />}</div>
          <div style={ROW}><b style={LABEL}>Settles</b><span>{data.config.crypto.replace(/_TEST$/, "")} on {NETWORKS[data.config.network] ?? data.config.network}, from the company wallet · partner customer <span className="mono">{data.config.customer_id}</span></span><span /></div>

          <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
            <b style={{ ...LABEL, padding: "8px 0 4px" }}>Who may pay</b>
            {roles.length === 0 ? <span style={{ fontSize: 13, color: "var(--ink-3)" }}>No role yet.</span> : roles.map((item) => (
              <div key={item.role} style={{ ...ROW, gridTemplateColumns: "150px minmax(0, 1fr) auto" }}>
                <b className="mono" style={{ fontSize: 13 }}>{item.role}</b>
                <span>{item.permission ? <>up to <b className="mono">{(Number(item.permission.maxPerPayout) / 1_000_000).toLocaleString("en-US")} EUR</b> per payout, from the {item.permission.budgetLabel ?? item.permission.budget?.slice(0, 10)} budget</> : <span style={{ color: "var(--ink-3)" }}>no euro payouts</span>}</span>
                {item.permission ? <button className="btn-line" style={{ fontSize: 10 }} disabled={sign.isPending} onClick={() => sign.mutate(bankApi.permissionProposal({ role: item.role, budget: null, maxPerPayout: null }))}>REMOVE</button> : <span />}
              </div>
            ))}
            {roles.length ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 0 4px", borderTop: "1px solid rgba(13,23,48,.12)" }}>
                <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Let</span>
                <select aria-label="Role" value={chosen?.role ?? ""} onChange={(event) => { setRole(event.target.value); setBudget(""); }} disabled={sign.isPending} style={{ padding: "8px 10px", border: "1px solid rgba(13,23,48,.2)", font: "13px var(--font-mono)" }}>
                  {roles.map((item) => <option key={item.role} value={item.role}>{item.role}</option>)}
                </select>
                <span style={{ fontSize: 13, color: "var(--ink-2)" }}>pay IBANs from</span>
                {euroBudgets.length ? (
                  <select aria-label="Budget" value={chosenBudget?.key ?? ""} onChange={(event) => setBudget(event.target.value)} disabled={sign.isPending} style={{ padding: "8px 10px", border: "1px solid rgba(13,23,48,.2)", font: "13px var(--font-mono)" }}>
                    {euroBudgets.map((item) => <option key={item.key} value={item.key}>{item.label} ({item.available ?? "?"} EURC left)</option>)}
                  </select>
                ) : (
                  <>
                    <span style={{ fontSize: 13, color: "var(--ink-2)" }}>a new euro budget of</span>
                    <input aria-label="Euro budget per day" value={daily} onChange={(event) => setDaily(event.target.value)} disabled={sign.isPending}
                      style={{ width: 80, padding: "8px 10px", border: "1px solid rgba(13,23,48,.2)", font: "14px var(--font-mono)" }} />
                    <span style={{ fontSize: 13, color: "var(--ink-2)" }}>EUR a day,</span>
                  </>
                )}
                <span style={{ fontSize: 13, color: "var(--ink-2)" }}>up to</span>
                <input aria-label="Ceiling per payout in EUR" value={ceiling} onChange={(event) => setCeiling(event.target.value)} disabled={sign.isPending}
                  style={{ width: 80, padding: "8px 10px", border: "1px solid rgba(13,23,48,.2)", font: "14px var(--font-mono)" }} />
                <span style={{ fontSize: 13, color: "var(--ink-2)" }}>EUR each</span>
                <button type="button" className="btn-ori" style={{ padding: "10px 16px", marginLeft: "auto" }} disabled={sign.isPending || !chosen || !ceilingUnits || (!chosenBudget && !dailyUnits)}
                  onClick={() => chosen && ceilingUnits && sign.mutate(bankApi.permissionProposal(chosenBudget
                    ? { role: chosen.role, budget: chosenBudget.key, maxPerPayout: ceilingUnits }
                    : { role: chosen.role, budget: null, maxPerPayout: ceilingUnits, newBudget: { amount: dailyUnits!, periodDays: 1 } }))}>
                  {sign.isPending ? "SIGNING…" : "PROPOSE"}
                </button>
              </div>
            ) : null}
            {!euroBudgets.length && chosen ? <span style={{ fontSize: 12, color: "var(--ink-3)" }}>The role has no EURC budget: the vote creates one, refilled daily, that only euro payouts draw on.</span> : null}
          </div>

          <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
            <b style={{ ...LABEL, padding: "8px 0 4px" }}>Payouts</b>
            {data.payouts.length === 0 ? (
              <span style={{ fontSize: 13, color: "var(--ink-3)", padding: "4px 0" }}>No euro payout yet.</span>
            ) : data.payouts.slice(0, 8).map((payout) => (
              <div key={payout.opId} style={{ ...ROW, gridTemplateColumns: "44px minmax(0, 1fr) auto" }}>
                <Seal word={STATE_WORD[payout.state] ?? payout.state} size={36} tone={payout.state === "Failed" ? "refused" : undefined} />
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span><b className="mono">{(Number(payout.amount) / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2 })} EUR</b> to beneficiary #{payout.beneficiary.id}{payout.beneficiary.label ? ` · ${payout.beneficiary.label}` : ""}</span>
                  <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{new Date(payout.at).toLocaleString()} · {payout.actor} ({payout.role}) · ref {payout.reference}{payout.fiatAmount ? ` · beneficiary receives ${payout.fiatAmount} in their currency` : ""}</span>
                  {payout.error ? <span title={payout.error} style={{ fontSize: 12, color: "#A33A2A" }}>{bankErrorText(payout.error)}</span> : null}
                </span>
                {explorer ? <a href={explorer} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "var(--aegean-ink)" }}>vault ↗</a> : <span />}
              </div>
            ))}
          </div>
        </>
      )}
      {sign.error ? <div role="alert" style={{ border: "1px solid rgba(217,87,59,.55)", background: "rgba(217,87,59,.08)", padding: "10px 12px", fontSize: 13, color: "var(--terra-ink)" }}>{sign.error.message}</div> : null}
    </Slab>
  );
}

const FREQUENCIES: Array<[string, number]> = [["Every month (30 days)", 30], ["Every 2 weeks", 14], ["Every week", 7], ["Every 10 minutes (demo)", 10 / 1440]];

/**
 * Payroll and other standing orders: the members vote once "beneficiary #3, 2 400 EUR every month
 * from the 28th"; the vault pays it on each date without another vote or an agent (the keeper only
 * starts it), to the sealed account the members voted, in its own currency.
 */
export function PayrollCard() {
  const wallets = useWallets();
  const client = useQueryClient();
  const policy = useQuery({ queryKey: ["bank-policy"], queryFn: bankApi.policy, refetchInterval: 15_000 });
  const orders = useQuery({ queryKey: ["standing-orders"], queryFn: bankApi.standingOrders, refetchInterval: 15_000 });
  const [beneficiaryId, setBeneficiaryId] = useState("");
  const [amount, setAmount] = useState("2400");
  const [firstAt, setFirstAt] = useState(() => new Date(Date.now() + 15 * 60_000).toISOString().slice(0, 16));
  const [periodDays, setPeriodDays] = useState(30);
  const [count, setCount] = useState("");
  const [label, setLabel] = useState("Payroll");
  const sign = useMutation({
    mutationFn: async (draft: Promise<ProposalDraft>) => {
      if (!wallets.nearAccountId) throw new Error("Connect your NEAR wallet first");
      await signDaoProposal(wallets.nearAccountId, await draft);
    },
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["omni-governance"] }); },
  });
  const data = policy.data;
  if (!data?.supported || !data.config) return null;
  const beneficiaries = data.beneficiaries;
  const chosen = Number(beneficiaryId || beneficiaries[0]?.id || 0);
  const units = /^\d{1,7}(\.\d{1,2})?$/.test(amount) ? String(Math.round(Number(amount) * 1_000_000)) : null;
  const labelOf = (id: number) => beneficiaries.find((entry) => entry.id === id)?.label || `#${id}`;
  const every = (days: number) => FREQUENCIES.find(([, value]) => Math.abs(value - days) < 1e-6)?.[0].toLowerCase() ?? `every ${days} days`;

  return (
    <Slab style={{ padding: "20px 24px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHead left={<Kicker>Payroll · standing orders</Kicker>} />
      <span style={{ fontSize: 13, lineHeight: 1.55, color: "var(--ink-2)" }}>
        Members vote once: who, how much, how often. On each date the vault pays the sealed account in its own currency (EUR, BRL, USD, GBP)
        from the company's euros, without another vote and without an agent. Salaries and accounts are never on chain; the amount is.
      </span>

      <div style={{ display: "flex", flexDirection: "column", marginTop: 4 }}>
        {(orders.data?.orders ?? []).length === 0 ? (
          <span style={{ fontSize: 13, color: "var(--ink-3)", padding: "4px 0" }}>No standing order yet.</span>
        ) : orders.data!.orders.map((order) => (
          <div key={order.id} style={{ ...ROW, gridTemplateColumns: "44px minmax(0, 1fr) auto" }}>
            <Seal word="VOTED" size={36} />
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span><b className="mono">{(Number(order.amount) / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2 })} EUR</b> to {labelOf(order.beneficiaryId)} · {every(order.periodDays)}{order.label ? ` · ${order.label}` : ""}</span>
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Next {new Date(order.nextAt).toLocaleString()} · paid {order.runs} time{order.runs === 1 ? "" : "s"}{order.remaining !== null ? ` · ${order.remaining} left` : ""}</span>
            </span>
            <button className="btn-line" style={{ fontSize: 10 }} disabled={sign.isPending} onClick={() => sign.mutate(bankApi.standingOrderProposal({ beneficiaryId: order.beneficiaryId, remove: order.id }))}>STOP</button>
          </div>
        ))}
      </div>

      {beneficiaries.length ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 0 4px", borderTop: "1px solid rgba(13,23,48,.12)" }}>
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Pay</span>
          <select aria-label="Beneficiary" value={chosen} onChange={(event) => setBeneficiaryId(event.target.value)} disabled={sign.isPending} style={{ padding: "8px 10px", border: "1px solid rgba(13,23,48,.2)", font: "13px var(--font-mono)" }}>
            {beneficiaries.map((entry) => <option key={entry.id} value={entry.id}>#{entry.id}{entry.label ? ` · ${entry.label}` : ""}</option>)}
          </select>
          <input aria-label="Amount in EUR" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={sign.isPending} style={{ width: 90, padding: "8px 10px", border: "1px solid rgba(13,23,48,.2)", font: "14px var(--font-mono)" }} />
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>EUR</span>
          <select aria-label="Frequency" value={periodDays} onChange={(event) => setPeriodDays(Number(event.target.value))} disabled={sign.isPending} style={{ padding: "8px 10px", border: "1px solid rgba(13,23,48,.2)", font: "13px var(--font-ui)" }}>
            {FREQUENCIES.map(([text, value]) => <option key={text} value={value}>{text}</option>)}
          </select>
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>from</span>
          <input aria-label="First payment (UTC)" type="datetime-local" value={firstAt} onChange={(event) => setFirstAt(event.target.value)} disabled={sign.isPending} style={{ padding: "7px 8px", border: "1px solid rgba(13,23,48,.2)", font: "13px var(--font-mono)" }} />
          <input aria-label="How many times (empty: until stopped)" placeholder="times (∞)" value={count} onChange={(event) => setCount(event.target.value.replace(/\D/g, ""))} disabled={sign.isPending} style={{ width: 80, padding: "8px 10px", border: "1px solid rgba(13,23,48,.2)", font: "13px var(--font-mono)" }} />
          <input aria-label="Public label" maxLength={32} value={label} onChange={(event) => setLabel(event.target.value)} disabled={sign.isPending} style={{ width: 110, padding: "8px 10px", border: "1px solid rgba(13,23,48,.2)", font: "13px var(--font-ui)" }} />
          <button type="button" className="btn-ori" style={{ padding: "10px 16px", marginLeft: "auto" }} disabled={sign.isPending || !units || !chosen}
            onClick={() => units && sign.mutate(bankApi.standingOrderProposal({ beneficiaryId: chosen, amount: units, firstAt: `${firstAt}:00Z`, periodDays, count: count ? Number(count) : null, label }))}>
            {sign.isPending ? "SIGNING…" : "PROPOSE"}
          </button>
        </div>
      ) : <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Vote a beneficiary first (Settings · suppliers).</span>}
      {sign.error ? <div role="alert" style={{ border: "1px solid rgba(217,87,59,.55)", background: "rgba(217,87,59,.08)", padding: "10px 12px", fontSize: 13, color: "var(--terra-ink)" }}>{sign.error.message}</div> : null}
    </Slab>
  );
}

/** The partner's refusal, in words a treasurer reads; the raw message stays on hover. */
export function bankErrorText(error: string): string {
  if (/channel policy denied|ImplicitDeny/i.test(error)) return "Not paid: the bank partner has not opened this payment rail for the company yet. The euros stayed in the company wallet.";
  if (/insufficient|balance/i.test(error)) return "Not paid: the company wallet did not hold enough EURC.";
  if (/expired/i.test(error)) return "Not paid: the partner's quote expired before the transfer. Ask again.";
  if (/noah \d{3}/i.test(error)) return "Not paid: the bank partner refused this payout. The euros stayed in the company wallet.";
  return `Not paid: ${error.length > 120 ? `${error.slice(0, 117)}…` : error}`;
}
