/**
 * Invoices the company issues, paid by SEPA transfer to its euro IBAN.
 *
 * Each invoice carries a creditor reference (ISO 11649, "RF…"), printed with a SEPA QR code
 * (EPC069-12) that any European banking app scans to fill the transfer. The bank partner reports
 * that reference on the deposit (its `FiatDeposit` webhook, signed with ECDSA P-384, verified
 * here); the invoice is matched to the deposit, and marked paid once the euros have reached the
 * company wallet as EURC, with the transaction's hash. In the sandbox, a simulated payment knows
 * its deposit at once.
 */
import { createHash, createPublicKey, createVerify } from "node:crypto";

import type { PrismaClient } from "@euthyna/db";

import { BankError } from "./service.js";
import type { NoahClient } from "./noah.js";

/** Noah's webhook keys (docs.noah.com, "Secure Your Endpoint"): they sign, we verify. */
export const NOAH_WEBHOOK_KEYS = {
  sandbox: `-----BEGIN PUBLIC KEY-----
MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEm8yBiD+kmVJ1Xc9sfRkDx0yo9+u8yiAD
PngI20KoEswz0gflp8o/z66Abqz/m9A1CBecixWdeT72pA8NZBJI6L6Osd8RV+yx
QArxeGKEVX/2QNrfPqeAKODHT5LdStGT
-----END PUBLIC KEY-----`,
  production: `-----BEGIN PUBLIC KEY-----
MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAELKJhxcUGJr3XgRrf+laSAVHvp31wFhE2
XdicXvF0DAdKzSPN8bkSdjrsUA6nnVUq3M47Y7RUYugMfkagaYjUExQZVjpMFg0P
DnXWl9y0dXYDq+pzYhAgL+MNpnY0eJ78
-----END PUBLIC KEY-----`,
};

const letters = (text: string) => text.toUpperCase().replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
function mod97(digits: string): number {
  let remainder = 0;
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder;
}

/** ISO 11649 creditor reference: "RF" + 2 check digits + up to 21 letters and digits. */
export function creditorReference(body: string): string {
  const clean = body.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 21);
  const check = 98 - mod97(letters(`${clean}RF00`));
  return `RF${String(check).padStart(2, "0")}${clean}`;
}

export function validCreditorReference(reference: string): boolean {
  const clean = reference.toUpperCase().replace(/\s+/g, "");
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(clean)) return false;
  return mod97(letters(`${clean.slice(4)}${clean.slice(0, 4)}`)) === 1;
}

/** EPC069-12 v002 (the "SEPA QR" / GiroCode): the payer's app fills IBAN, name, amount, reference. */
export function epcQrPayload(input: { bic: string; name: string; iban: string; cents: number; reference: string }): string {
  const amount = (input.cents / 100).toFixed(2);
  return ["BCD", "002", "1", "SCT", input.bic, input.name.slice(0, 70), input.iban.replace(/\s+/g, ""), `EUR${amount}`, "", input.reference, ""].join("\n");
}

export function verifyNoahWebhook(rawBody: string, signature: string | undefined, publicKeyPem: string): boolean {
  if (!signature) return false;
  try {
    const verifier = createVerify("SHA384");
    verifier.update(rawBody);
    return verifier.verify(createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export type InvoiceView = {
  id: string; number: string; reference: string; customerName: string; customerEmail: string | null; description: string;
  amount: string; currency: string; dueDate: string; status: string; paidAt: string | null; paidAmount: string | null;
  payerName: string | null; txHash: string | null; createdAt: string; qr: string | null;
};

type FiatDepositEvent = {
  EventType?: string;
  Data?: { ID?: string; CustomerID?: string; FiatAmount?: string; FiatCurrency?: string; Status?: string; Reference?: string; Sender?: { FullName?: string } };
};

const cents = (amount: string) => Math.round(Number(amount) * 100);
const euros = (value: number) => (value / 100).toFixed(2);

export class InvoiceService {
  constructor(private readonly deps: { prisma: PrismaClient; noah: NoahClient; explorer?: string }) {}

  private async account(organizationId: string) {
    const account = await this.deps.prisma.bankAccount.findFirst({ where: { organizationId, provider: "noah" } });
    if (!account) throw new BankError(409, "bank_account_missing", "open the company's euro account first: invoices are paid to its IBAN");
    return account;
  }

  private view(invoice: Awaited<ReturnType<PrismaClient["invoice"]["findFirstOrThrow"]>>, account: { bic: string; accountHolder: string; iban: string } | null): InvoiceView {
    return {
      id: invoice.id, number: invoice.number, reference: invoice.reference, customerName: invoice.customerName, customerEmail: invoice.customerEmail,
      description: invoice.description, amount: euros(invoice.amountCents), currency: invoice.currency, dueDate: invoice.dueDate.toISOString(),
      status: invoice.status, paidAt: invoice.paidAt?.toISOString() ?? null, paidAmount: invoice.paidCents === null ? null : euros(invoice.paidCents),
      payerName: invoice.payerName, txHash: invoice.txHash, createdAt: invoice.createdAt.toISOString(),
      qr: account && invoice.status === "open" ? epcQrPayload({ bic: account.bic, name: account.accountHolder, iban: account.iban, cents: invoice.amountCents, reference: invoice.reference }) : null,
    };
  }

  async create(organizationId: string, input: { customerName: string; customerEmail?: string | undefined; description: string; amount: string; dueInDays: number }): Promise<InvoiceView> {
    const account = await this.account(organizationId);
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(input.amount) || cents(input.amount) <= 0) throw new BankError(400, "invalid_amount", "The amount must be positive, in euros");
    const year = new Date().getUTCFullYear();
    const count = await this.deps.prisma.invoice.count({ where: { organizationId, number: { startsWith: `INV-${year}-` } } });
    const number = `INV-${year}-${String(count + 1).padStart(4, "0")}`;
    // Unique across companies: the invoice number and 6 characters of the company.
    const tag = createHash("sha256").update(organizationId).digest("hex").slice(0, 6).toUpperCase();
    const reference = creditorReference(`${number.replace(/-/g, "")}${tag}`);
    const invoice = await this.deps.prisma.invoice.create({
      data: {
        organizationId, number, reference, customerName: input.customerName.trim(), customerEmail: input.customerEmail?.trim() || null,
        description: input.description.trim(), amountCents: cents(input.amount), dueDate: new Date(Date.now() + input.dueInDays * 86_400_000),
      },
    });
    return this.view(invoice, account);
  }

  /** The company's invoices, with the paid ones confirmed against the partner's transactions. */
  async list(organizationId: string): Promise<{ invoices: InvoiceView[]; account: { iban: string; bic: string; holder: string } | null }> {
    const account = await this.deps.prisma.bankAccount.findFirst({ where: { organizationId, provider: "noah" } });
    const awaiting = await this.deps.prisma.invoice.findMany({ where: { organizationId, status: "open", depositId: { not: null } } });
    if (account && awaiting.length) {
      const items = (await this.deps.noah.transactions(account.customerId, 50).catch(() => ({ Items: [] }))).Items ?? [];
      for (const invoice of awaiting) {
        // Paid when the euros are in the company wallet: the partner's transfer to it carries the
        // deposit as its orchestration (RuleExecutionID = FiatDepositID) and its Base hash.
        const settled = items.find((item) => item.Direction === "Out" && item.Status === "Settled" && (item as { Orchestration?: { RuleExecutionID?: string } }).Orchestration?.RuleExecutionID === invoice.depositId);
        if (!settled) continue;
        const tx = settled.PublicID && /^0x[0-9a-fA-F]{64}$/.test(settled.PublicID) ? settled.PublicID : null;
        await this.deps.prisma.invoice.update({ where: { id: invoice.id }, data: { status: (invoice.paidCents ?? 0) >= invoice.amountCents ? "paid" : "open", paidAt: new Date(settled.Created), txHash: tx } });
      }
    }
    const invoices = await this.deps.prisma.invoice.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 100 });
    return { invoices: invoices.map((invoice) => this.view(invoice, account)), account: account ? { iban: account.iban, bic: account.bic, holder: account.accountHolder } : null };
  }

  async cancel(organizationId: string, id: string): Promise<InvoiceView> {
    const invoice = await this.deps.prisma.invoice.findFirst({ where: { id, organizationId } });
    if (!invoice) throw new BankError(404, "invoice_missing", "no such invoice");
    if (invoice.status !== "open") throw new BankError(409, "invoice_closed", "only an open invoice can be cancelled");
    return this.view(await this.deps.prisma.invoice.update({ where: { id }, data: { status: "cancelled" } }), null);
  }

  /** Sandbox only: the customer pays the invoice (a SEPA transfer with its reference). */
  async simulatePayment(organizationId: string, id: string): Promise<InvoiceView> {
    const account = await this.account(organizationId);
    if (!account.sandbox || !this.deps.noah.sandbox) throw new BankError(400, "not_sandbox", "payments can be simulated only in the sandbox");
    const invoice = await this.deps.prisma.invoice.findFirst({ where: { id, organizationId } });
    if (!invoice || invoice.status !== "open") throw new BankError(409, "invoice_closed", "only an open invoice can be paid");
    const { FiatDepositID } = await this.deps.noah.simulateDeposit(account.paymentMethodId, euros(invoice.amountCents), invoice.reference);
    return this.view(await this.deps.prisma.invoice.update({ where: { id }, data: { depositId: FiatDepositID, paidCents: invoice.amountCents, payerName: "Sandbox payer" } }), account);
  }

  /**
   * The partner's `FiatDeposit` webhook: the deposit's reference names the invoice. Only a
   * deposit on the invoice's own company account counts. Returns what was matched.
   */
  async onFiatDeposit(event: FiatDepositEvent): Promise<{ matched: string | null }> {
    const data = event.Data;
    if (event.EventType !== "FiatDeposit" || !data?.ID || !data.Reference || data.FiatCurrency !== "EUR") return { matched: null };
    const found = /RF\d{2}[A-Z0-9]{1,21}/.exec(data.Reference.toUpperCase().replace(/\s+/g, ""))?.[0];
    if (!found || !validCreditorReference(found)) return { matched: null };
    const invoice = await this.deps.prisma.invoice.findUnique({ where: { reference: found } });
    if (!invoice || invoice.status !== "open") return { matched: null };
    const account = await this.deps.prisma.bankAccount.findFirst({ where: { organizationId: invoice.organizationId, provider: "noah" } });
    if (!account || account.customerId !== data.CustomerID) return { matched: null };
    await this.deps.prisma.invoice.update({
      where: { id: invoice.id },
      data: { depositId: data.ID, paidCents: cents(data.FiatAmount ?? "0"), payerName: data.Sender?.FullName?.slice(0, 120) ?? null },
    });
    return { matched: invoice.number };
  }
}
