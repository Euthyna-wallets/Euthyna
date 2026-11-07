import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Kicker, SectionHead, Slab } from "../components/design.js";
import { bankApi, type BankBusiness } from "../omniroles-api.js";

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
