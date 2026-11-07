import type { PrismaClient } from "@euthyna/db";
import { describe, expect, it, vi } from "vitest";

import { NoahClient } from "./noah.js";
import { BankService } from "./service.js";

const WALLET = "0x9435c2d547099D9cd9c82e29290753b590a8aF1e";
const business = {
  registeredName: "Acme AI", registrationNumber: "123", entityType: "LimitedLiabilityCompany", country: "FR",
  street: "1 Rue", city: "Nantes", postCode: "44000", state: "Loire-Atlantique", incorporationDate: "2026-11-01", taxId: "FR1",
};

function setup(options: { returned?: string; wallet?: { address: string; chainId: number } | null; apiUrl?: string } = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(/^https:\/\/[^/]+\/v1/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body });
    if (path.startsWith("/workflows/")) {
      return new Response(JSON.stringify({
        AccountHolderName: "Acme AI", AccountNumber: "MT49CFTE1987", BankCode: "CFTEMTM1XXX", BankName: "OpenPayd",
        PaymentMethodID: "Bank/Sepa/EUR/x", VirtualAccountID: "va1", CryptoCurrency: "EURC_TEST", Network: "BaseTestSepolia",
        DestinationAddress: { Address: options.returned ?? WALLET },
      }));
    }
    if (path.startsWith("/transactions")) return new Response(JSON.stringify({ Items: [{ ID: "t1", PublicID: `0x${"ab".repeat(32)}`, Created: "2026-11-07T16:26:33Z", Status: "Settled", Direction: "Out", Amount: "24.94", CryptoCurrency: "EURC_TEST", Network: "BaseTestSepolia" }] }));
    if (path.startsWith("/sandbox/")) return new Response(JSON.stringify({ FiatDepositID: "dep1" }));
    return new Response("{}", { status: 201 });
  });
  let saved: Record<string, unknown> | null = null;
  const prisma = {
    bankAccount: {
      findFirst: async () => saved && { ...saved, createdAt: new Date("2026-11-07T00:00:00Z") },
      create: async ({ data }: { data: Record<string, unknown> }) => { saved = data; return data; },
    },
  } as unknown as PrismaClient;
  const noah = new NoahClient({ apiUrl: options.apiUrl ?? "https://api.sandbox.noah.com/v1", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
  const service = new BankService({ prisma, noah, companyWallet: async () => (options.wallet === undefined ? { address: WALLET, chainId: 84532 } : options.wallet) });
  return { service, calls, saved: () => saved };
}

describe("company euro account", () => {
  it("opens an IBAN that settles EURC into the company wallet read from the vault", async () => {
    const { service, calls } = setup();
    const view = await service.open("org-1", business);
    const workflow = calls.find((call) => call.path.startsWith("/workflows/"))!;
    expect(workflow.body).toEqual({ CustomerID: "euthyna-org-1", FiatCurrency: "EUR", CryptoCurrency: "EURC_TEST", Network: "BaseTestSepolia", DestinationAddress: { Address: WALLET } });
    expect(view.account).toMatchObject({ iban: "MT49CFTE1987", destinationAddress: WALLET, settlesAs: "EURC_TEST" });
    expect(view.transfers[0]).toMatchObject({ direction: "out", amount: "24.94", explorer: `https://sepolia.basescan.org/tx/0x${"ab".repeat(32)}` });
  });

  it("saves nothing when the partner settles to another address", async () => {
    const { service, saved } = setup({ returned: "0x000000000000000000000000000000000000dEaD" });
    await expect(service.open("org-1", business)).rejects.toMatchObject({ code: "destination_mismatch" });
    expect(saved()).toBeNull();
  });

  it("needs the company wallet first", async () => {
    const { service, calls } = setup({ wallet: null });
    await expect(service.open("org-1", business)).rejects.toMatchObject({ code: "wallet_missing" });
    expect(calls).toHaveLength(0);
  });

  it("opens one account per company", async () => {
    const { service } = setup();
    await service.open("org-1", business);
    await expect(service.open("org-1", business)).rejects.toMatchObject({ code: "bank_account_exists" });
  });

  it("simulates a SEPA transfer only in the sandbox", async () => {
    const sandbox = setup();
    await sandbox.service.open("org-1", business);
    await expect(sandbox.service.simulateDeposit("org-1", "25")).resolves.toEqual({ depositId: "dep1" });
    const production = setup({ apiUrl: "https://api.noah.com/v1", wallet: { address: WALLET, chainId: 84532 } });
    await expect(production.service.open("org-1", business)).rejects.toMatchObject({ code: "chain_unsupported" });
  });
});
