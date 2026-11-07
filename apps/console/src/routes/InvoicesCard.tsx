/**
 * Invoices the company issues. Each carries a creditor reference (RF…) and a SEPA QR code: the
 * customer scans it in any European banking app, the transfer reaches the company's euro IBAN with
 * that reference, and the invoice turns paid once the euros are in the company wallet as EURC.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useState } from "react";

import { Kicker, Seal, SectionHead, Slab } from "../components/design.js";
import { invoicesApi, type InvoiceView } from "../omniroles-api.js";

const ROW = { display: "grid", gridTemplateColumns: "44px minmax(0, 1fr) auto", gap: 12, alignItems: "center", padding: "9px 0", borderTop: "1px solid rgba(13,23,48,.12)", fontSize: 13 } as const;
const INPUT = { padding: "8px 10px", border: "1px solid rgba(13,23,48,.2)", font: "13px var(--font-ui)" } as const;
const groupIban = (iban: string) => iban.replace(/(.{4})/g, "$1 ").trim();
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Spreadsheet formulas are not run from an export (=, +, -, @ at the start of a cell).
const cell = (text: string) => `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;

async function printInvoice(invoice: InvoiceView, account: { iban: string; bic: string; holder: string }) {
  const qr = invoice.qr ? await QRCode.toDataURL(invoice.qr, { errorCorrectionLevel: "M", margin: 1, width: 220 }) : null;
  const page = window.open("", "_blank");
  if (!page) throw new Error("Allow pop-ups to print the invoice.");
  page.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(invoice.number)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#0d1730;max-width:720px;margin:40px auto;padding:0 24px}h1{font-size:22px;letter-spacing:.08em}
table{width:100%;border-collapse:collapse;margin:24px 0}td{padding:8px 0;border-bottom:1px solid #ddd}.r{text-align:right}.mono{font-family:ui-monospace,monospace}
.pay{display:flex;gap:24px;align-items:center;border:1px solid #ccd;padding:16px;margin-top:24px}small{color:#556}</style></head><body>
<h1>INVOICE ${escapeHtml(invoice.number)}</h1>
<p><b>${escapeHtml(account.holder)}</b><br><small>Issued ${new Date(invoice.createdAt).toLocaleDateString()} · due ${new Date(invoice.dueDate).toLocaleDateString()}</small></p>
<p>Bill to: <b>${escapeHtml(invoice.customerName)}</b>${invoice.customerEmail ? `<br><small>${escapeHtml(invoice.customerEmail)}</small>` : ""}</p>
<table><tr><td>${escapeHtml(invoice.description)}</td><td class="r"><b>${escapeHtml(invoice.amount)} EUR</b></td></tr></table>
<div class="pay">${qr ? `<img src="${qr}" width="160" height="160" alt="SEPA QR code">` : ""}<div>
<b>Pay by SEPA transfer</b><br>IBAN <span class="mono">${escapeHtml(groupIban(account.iban))}</span><br>BIC <span class="mono">${escapeHtml(account.bic)}</span><br>
Reference <span class="mono"><b>${escapeHtml(invoice.reference)}</b></span><br><small>Scan the code in your banking app: the IBAN, the amount and the reference are filled in. Keep the reference: it settles this invoice.</small></div></div>
<script>window.onload=()=>window.print()</script></body></html>`);
  page.document.close();
}

export function InvoicesCard() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["invoices"], queryFn: invoicesApi.list, refetchInterval: 15_000 });
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [dueInDays, setDueInDays] = useState(30);
  const refresh = () => client.invalidateQueries({ queryKey: ["invoices"] });
  const create = useMutation({
    mutationFn: () => invoicesApi.create({ customerName, ...(customerEmail.trim() ? { customerEmail: customerEmail.trim() } : {}), description, amount, dueInDays }),
    onSuccess: async () => { setCustomerName(""); setCustomerEmail(""); setDescription(""); setAmount(""); await refresh(); },
  });
  const act = useMutation({ mutationFn: (work: () => Promise<unknown>) => work(), onSuccess: refresh });
  const data = query.data;
  if (!data?.account) return null;
  const account = data.account;
  const exportCsv = () => {
    const lines = [["Number", "Customer", "Description", "Amount EUR", "Due", "Status", "Paid at", "Paid by", "Reference", "Transaction"].map(cell).join(",")];
    for (const invoice of data.invoices) {
      lines.push([invoice.number, invoice.customerName, invoice.description, invoice.amount, invoice.dueDate.slice(0, 10), invoice.status, invoice.paidAt?.slice(0, 10) ?? "", invoice.payerName ?? "", invoice.reference, invoice.txHash ?? ""].map(cell).join(","));
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([`${lines.join("\n")}\n`], { type: "text/csv" }));
    link.download = "invoices.csv";
    link.click();
  };
  const valid = customerName.trim() && description.trim() && /^\d{1,7}(\.\d{1,2})?$/.test(amount) && Number(amount) > 0;

  return (
    <Slab style={{ padding: "20px 24px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHead
        left={<Kicker>Invoices · paid by SEPA</Kicker>}
        right={data.invoices.length ? <button className="btn-line" style={{ fontSize: 10 }} onClick={exportCsv}>EXPORT CSV</button> : null}
      />
      <span style={{ fontSize: 13, lineHeight: 1.55, color: "var(--ink-2)" }}>
        Each invoice has its own reference and a SEPA QR code: the customer scans it in their banking app and pays the company's IBAN.
        The bank partner reports the reference with the transfer, so the invoice settles itself once the euros are in the company wallet.
      </span>

      <div style={{ display: "flex", flexDirection: "column", marginTop: 4 }}>
        {data.invoices.length === 0 ? <span style={{ fontSize: 13, color: "var(--ink-3)", padding: "4px 0" }}>No invoice yet.</span> : data.invoices.slice(0, 12).map((invoice) => (
          <div key={invoice.id} style={ROW}>
            <Seal word={invoice.status === "paid" ? "PAID" : invoice.status === "cancelled" ? "VOID" : "OPEN"} size={36} tone={invoice.status === "cancelled" ? "expired" : undefined} />
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span><b className="mono">{invoice.number}</b> · {invoice.customerName} · <b className="mono">{invoice.amount} EUR</b></span>
              <span style={{ fontSize: 12, color: "var(--ink-3)", overflowWrap: "anywhere" }}>
                {invoice.description} · ref <span className="mono">{invoice.reference}</span> ·{" "}
                {invoice.status === "paid"
                  ? <>paid {invoice.paidAt ? new Date(invoice.paidAt).toLocaleDateString() : ""}{invoice.payerName ? ` by ${invoice.payerName}` : ""}{invoice.txHash ? <> · <a href={`https://sepolia.basescan.org/tx/${invoice.txHash}`} target="_blank" rel="noreferrer">EURC ↗</a></> : null}</>
                  : invoice.status === "open" ? `due ${new Date(invoice.dueDate).toLocaleDateString()}` : "cancelled"}
              </span>
            </span>
            <span style={{ display: "flex", gap: 6 }}>
              {invoice.status === "open" ? <>
                <button className="btn-line" style={{ fontSize: 10 }} disabled={act.isPending} onClick={() => act.mutate(() => printInvoice(invoice, account))}>PDF · QR</button>
                <button className="btn-line" style={{ fontSize: 10 }} disabled={act.isPending} onClick={() => act.mutate(() => invoicesApi.simulate(invoice.id))} title="Sandbox: the customer pays this invoice">SIMULATE PAYMENT</button>
                <button className="btn-line" style={{ fontSize: 10 }} disabled={act.isPending} onClick={() => act.mutate(() => invoicesApi.cancel(invoice.id))}>CANCEL</button>
              </> : null}
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 0 4px", borderTop: "1px solid rgba(13,23,48,.12)" }}>
        <input aria-label="Customer" placeholder="Customer" value={customerName} onChange={(e) => setCustomerName(e.target.value)} maxLength={120} style={{ ...INPUT, flex: "1 1 160px" }} />
        <input aria-label="Customer email (optional)" placeholder="Email (optional)" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} maxLength={200} style={{ ...INPUT, flex: "1 1 160px" }} />
        <input aria-label="Description" placeholder="What for" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} style={{ ...INPUT, flex: "2 1 220px" }} />
        <input aria-label="Amount in EUR" placeholder="EUR" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ ...INPUT, width: 90, fontFamily: "var(--font-mono)" }} />
        <select aria-label="Due in" value={dueInDays} onChange={(e) => setDueInDays(Number(e.target.value))} style={INPUT}>
          {[[0, "Due now"], [15, "15 days"], [30, "30 days"], [45, "45 days"], [60, "60 days"]].map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
        <button type="button" className="btn-ori" style={{ padding: "10px 16px", marginLeft: "auto" }} disabled={create.isPending || !valid} onClick={() => create.mutate()}>
          {create.isPending ? "CREATING…" : "NEW INVOICE"}
        </button>
      </div>
      {create.error || act.error ? <div role="alert" style={{ border: "1px solid rgba(217,87,59,.55)", background: "rgba(217,87,59,.08)", padding: "10px 12px", fontSize: 13, color: "var(--terra-ink)" }}>{(create.error ?? act.error)?.message}</div> : null}
    </Slab>
  );
}
