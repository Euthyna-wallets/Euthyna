import { createSign, generateKeyPairSync } from "node:crypto";

import type { PrismaClient } from "@euthyna/db";
import { describe, expect, it, vi } from "vitest";

import { creditorReference, epcQrPayload, InvoiceService, NOAH_WEBHOOK_KEYS, validCreditorReference, verifyNoahWebhook } from "./invoices.js";
import { NoahClient } from "./noah.js";

type Row = Record<string, unknown> & { id: string; organizationId: string; status: string; amountCents: number; reference: string; number: string; depositId: string | null; paidCents: number | null; createdAt: Date; dueDate: Date };

function setup(options: { transactions?: unknown[] } = {}) {
  const rows: Row[] = [];
  const account = { organizationId: "org-1", provider: "noah", sandbox: true, customerId: "eut-abc", paymentMethodId: "Bank/Sepa/EUR/x", iban: "MT04CFTE19870000000090010358482", bic: "CFTEMTM1XXX", accountHolder: "Acme AI SAS" };
  const match = (row: Row, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "startsWith" in value) return String(row[key]).startsWith(String((value as { startsWith: string }).startsWith));
    if (value && typeof value === "object" && "not" in value) return row[key] !== (value as { not: unknown }).not;
    return row[key] === value;
  });
  const prisma = {
    bankAccount: { findFirst: async ({ where }: { where: { organizationId: string } }) => (where.organizationId === "org-1" ? account : null) },
    invoice: {
      count: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => match(row, where)).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `inv-${rows.length + 1}`, status: "open", depositId: null, paidCents: null, payerName: null, paidAt: null, txHash: null, currency: "EUR", createdAt: new Date(), customerEmail: null, ...data } as unknown as Row;
        rows.push(row);
        return row;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => match(row, where)),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => match(row, where)) ?? null,
      findUnique: async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => match(row, where)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(rows.find((row) => row.id === where.id)!, data),
    },
  } as unknown as PrismaClient;
  const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const path = String(url);
    if (path.includes("/sandbox/fiat-deposit/simulate")) return new Response(JSON.stringify({ FiatDepositID: "dep-1" }));
    if (path.includes("/transactions")) return new Response(JSON.stringify({ Items: options.transactions ?? [] }));
    return new Response("{}");
  });
  const noah = new NoahClient({ apiUrl: "https://api.sandbox.noah.com/v1", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
  return { service: new InvoiceService({ prisma, noah }), rows, fetchMock };
}

describe("invoices", () => {
  it("creditor references follow ISO 11649", () => {
    expect(creditorReference("539007547034")).toBe("RF18539007547034"); // the standard's example
    expect(validCreditorReference("RF18 5390 0754 7034")).toBe(true);
    expect(validCreditorReference("RF19539007547034")).toBe(false);
  });

  it("builds the SEPA QR (EPC069-12) a banking app scans", () => {
    const payload = epcQrPayload({ bic: "CFTEMTM1XXX", name: "Acme AI SAS", iban: "MT04 CFTE 1987 0000 0000 9001 0358 482", cents: 120000, reference: "RF18539007547034" });
    expect(payload.split("\n")).toEqual(["BCD", "002", "1", "SCT", "CFTEMTM1XXX", "Acme AI SAS", "MT04CFTE19870000000090010358482", "EUR1200.00", "", "RF18539007547034", ""]);
  });

  it("numbers invoices and gives each a valid, unique reference and its QR", async () => {
    const { service } = setup();
    const first = await service.create("org-1", { customerName: "Client SARL", description: "Audit, October", amount: "1200", dueInDays: 30 });
    const second = await service.create("org-1", { customerName: "Client SARL", description: "Audit, November", amount: "80.5", dueInDays: 30 });
    expect(first.number).toMatch(/^INV-\d{4}-0001$/);
    expect(second.number).toMatch(/-0002$/);
    expect(validCreditorReference(first.reference)).toBe(true);
    expect(first.reference).not.toBe(second.reference);
    expect(first.qr).toContain("EUR1200.00");
    expect(second.amount).toBe("80.50");
  });

  it("accepts only the partner's signed webhook", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const body = JSON.stringify({ EventType: "FiatDeposit", Data: { ID: "d" } });
    const signature = createSign("SHA384").update(body).sign(privateKey).toString("base64");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyNoahWebhook(body, signature, pem)).toBe(true);
    expect(verifyNoahWebhook(body.replace("d", "e"), signature, pem)).toBe(false);
    expect(verifyNoahWebhook(body, undefined, pem)).toBe(false);
    expect(verifyNoahWebhook(body, signature, NOAH_WEBHOOK_KEYS.sandbox)).toBe(false);
  });

  it("matches a deposit by its reference, only on the invoice's own account, then marks it paid once settled", async () => {
    const { service, rows } = setup({ transactions: [
      { Direction: "In", Status: "Settled", Created: "2026-11-08T10:00:00Z", FiatPayment: { FiatDepositID: "dep-9" }, Orchestration: { RuleExecutionID: "dep-9" } },
      { Direction: "Out", Status: "Settled", Created: "2026-11-08T10:00:11Z", PublicID: `0x${"ab".repeat(32)}`, Orchestration: { RuleExecutionID: "dep-9" } },
    ] });
    const invoice = await service.create("org-1", { customerName: "Client SARL", description: "Audit", amount: "1200", dueInDays: 30 });
    const event = (customer: string, reference: string) => ({ EventType: "FiatDeposit", Data: { ID: "dep-9", CustomerID: customer, FiatAmount: "1200", FiatCurrency: "EUR", Status: "Settled", Reference: reference, Sender: { FullName: "CLIENT SARL" } } });
    expect(await service.onFiatDeposit(event("eut-other", invoice.reference))).toEqual({ matched: null });
    expect(await service.onFiatDeposit(event("eut-abc", "RF00WRONG"))).toEqual({ matched: null });
    // Banks may space the reference or add text around it.
    expect(await service.onFiatDeposit(event("eut-abc", `Payment ${invoice.reference.replace(/(.{4})/g, "$1 ")}`))).toEqual({ matched: invoice.number });
    const listed = (await service.list("org-1")).invoices[0]!;
    expect(listed).toMatchObject({ status: "paid", payerName: "CLIENT SARL", paidAmount: "1200.00", txHash: `0x${"ab".repeat(32)}`, qr: null });
    expect(rows[0]!.depositId).toBe("dep-9");
  });

  it("a partial payment leaves the invoice open", async () => {
    const { service } = setup({ transactions: [{ Direction: "Out", Status: "Settled", Created: "2026-11-08T10:00:00Z", Orchestration: { RuleExecutionID: "dep-2" } }] });
    const invoice = await service.create("org-1", { customerName: "C", description: "D", amount: "100", dueInDays: 30 });
    await service.onFiatDeposit({ EventType: "FiatDeposit", Data: { ID: "dep-2", CustomerID: "eut-abc", FiatAmount: "40", FiatCurrency: "EUR", Reference: invoice.reference } });
    expect((await service.list("org-1")).invoices[0]!.status).toBe("open");
  });

  it("sandbox: the customer pays with the invoice's reference", async () => {
    const { service, fetchMock } = setup();
    const invoice = await service.create("org-1", { customerName: "C", description: "D", amount: "12.5", dueInDays: 30 });
    await service.simulatePayment("org-1", invoice.id);
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("simulate"))!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({ FiatAmount: "12.50", FiatCurrency: "EUR", Reference: invoice.reference });
  });
});
