/**
 * An invoice against Noah's sandbox, end to end: issue it for a company that has a euro account,
 * the customer pays it (simulated SEPA transfer with its reference), wait until it is paid.
 *
 *   NOAH_API_KEY=… DATABASE_URL=… ORG=bank-e2e-sealedprod1106 pnpm --filter @euthyna/api exec tsx scripts/invoice-sandbox-e2e.ts
 */
import { prisma } from "@euthyna/db";
import { InvoiceService } from "../src/bank/invoices.js";
import { NoahClient } from "../src/bank/noah.js";

const apiKey = process.env.NOAH_API_KEY;
if (!apiKey) throw new Error("NOAH_API_KEY is required");
const organizationId = process.env.ORG ?? "bank-e2e-sealedprod1106";
const invoices = new InvoiceService({ prisma, noah: new NoahClient({ apiUrl: process.env.NOAH_API_URL ?? "https://api.sandbox.noah.com/v1", apiKey }) });
const invoice = await invoices.create(organizationId, { customerName: "Client SARL", customerEmail: "ap@client.example", description: "Monthly audit, November", amount: process.env.AMOUNT ?? "42.50", dueInDays: 30 });
console.log(`issued ${invoice.number} · ${invoice.amount} EUR · reference ${invoice.reference}`);
console.log(`SEPA QR payload: ${JSON.stringify(invoice.qr)}`);
await invoices.simulatePayment(organizationId, invoice.id);
console.log("the customer pays it by SEPA, with the reference");
for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const found = (await invoices.list(organizationId)).invoices.find((item) => item.id === invoice.id)!;
  if (found.status === "paid") {
    console.log(`PAID ${found.paidAt} · ${found.paidAmount} EUR · EURC ${found.txHash}`);
    await prisma.$disconnect();
    process.exit(0);
  }
}
await prisma.$disconnect();
throw new Error("not paid after 300 s");
