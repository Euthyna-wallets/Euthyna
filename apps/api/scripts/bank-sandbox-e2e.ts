/**
 * The company euro account against Noah's sandbox and Base Sepolia, end to end:
 * open the account for a real Euthyna vault, simulate a SEPA transfer, wait for the EURC.
 *
 *   NOAH_API_KEY=… DATABASE_URL=… VAULT=testdao4ai.euthyna-nomos.testnet \
 *     pnpm --filter @euthyna/api exec tsx scripts/bank-sandbox-e2e.ts
 *
 * The settlement address is read from the vault on NEAR, as in the API.
 */
import { prisma } from "@euthyna/db";

import { NoahClient } from "../src/bank/noah.js";
import { BankService } from "../src/bank/service.js";

const EURC = "0x623ef90571256F905B2Fde947dC33098BdD8F4d8";
const vault = process.env.VAULT ?? "testdao4ai.euthyna-nomos.testnet";
const near = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const base = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";

async function walletOf(account: string): Promise<string | null> {
  const response = await fetch(near, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "query",
    params: { request_type: "call_function", finality: "final", account_id: account, method_name: "get_wallet", args_base64: Buffer.from(JSON.stringify({ chain_id: 84532 })).toString("base64") },
  }) });
  const result = (await response.json()) as { result?: { result: number[] } };
  const wallet = result.result ? JSON.parse(Buffer.from(result.result.result).toString()) as { address: number[] | null } | null : null;
  return wallet?.address ? `0x${Buffer.from(wallet.address).toString("hex")}` : null;
}

async function eurcOf(address: string): Promise<number> {
  const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: EURC, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"],
  }) });
  return Number(BigInt(((await response.json()) as { result: string }).result)) / 1e6;
}

const apiKey = process.env.NOAH_API_KEY;
if (!apiKey) throw new Error("NOAH_API_KEY is required");
const address = await walletOf(vault);
if (!address) throw new Error(`${vault} has no Base Sepolia wallet`);

const organizationId = `bank-e2e-${vault.split(".")[0]}`;
await prisma.organization.upsert({ where: { id: organizationId }, create: { id: organizationId, name: `${vault.split(".")[0]} (bank e2e)`, slug: organizationId, createdAt: new Date() }, update: {} });
const bank = new BankService({ prisma, noah: new NoahClient({ apiUrl: process.env.NOAH_API_URL ?? "https://api.sandbox.noah.com/v1", apiKey }), companyWallet: async () => ({ address, chainId: 84532, vaultAccountId: vault }) });

// REOPEN=1: forget the local row (an account opened before the customer was derived from the vault).
if (process.env.REOPEN === "1") await prisma.bankAccount.deleteMany({ where: { organizationId, provider: "noah" } });
let view = await bank.view(organizationId);
if (!view.account) {
  view = await bank.open(organizationId, {
    registeredName: `${vault.split(".")[0]} (Euthyna sandbox test)`, registrationNumber: "SANDBOX-E2E", entityType: "LimitedLiabilityCompany", country: "FR",
    street: "1 Rue de Test", city: "Nantes", postCode: "44000", state: "Loire-Atlantique", incorporationDate: "2026-11-01", taxId: "SANDBOX-TAX",
  });
}
console.log(`IBAN ${view.account!.iban} · ${view.account!.bankName} · settles ${view.account!.settlesAs} into ${view.account!.destinationAddress} (${view.account!.network})`);

const before = await eurcOf(address);
const { depositId } = await bank.simulateDeposit(organizationId, process.env.AMOUNT ?? "20");
console.log(`SEPA transfer simulated (${depositId}); EURC before: ${before}`);
for (let attempt = 0; attempt < 40; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const after = await eurcOf(address);
  if (after > before) {
    console.log(`EURC after: ${after} (+${(after - before).toFixed(6)})`);
    for (const transfer of (await bank.view(organizationId)).transfers.slice(0, 2)) console.log(`${transfer.created} ${transfer.direction} ${transfer.amount} ${transfer.currency} ${transfer.status} ${transfer.explorer ?? ""}`);
    await prisma.$disconnect();
    process.exit(0);
  }
}
await prisma.$disconnect();
throw new Error("no EURC after 400 s");
