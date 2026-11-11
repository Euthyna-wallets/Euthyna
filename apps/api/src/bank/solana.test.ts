import type { PrismaClient } from "@euthyna/db";
import { describe, expect, it, vi } from "vitest";

import { NoahClient } from "./noah.js";
import { BankService } from "./service.js";

const SOLANA = "Aeo7Nbs7U4trXo49Uf1bxVw5D1JWc9hFihv1xSsJkvZr";
const SIG = "4qYwc2DUFDsZjgSggoro2T4nkeJRmTf2zd5umPQ4B5PCxWoEeDgJ7D4WaQjAH2g1fEUQFEwPNDYKJ6WtczQsgigN";

function setup(options: { returned?: string; solana?: string | null } = {}) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(/^https:\/\/[^/]+\/v1/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path.startsWith("/workflows/")) {
      return new Response(JSON.stringify({
        AccountHolderName: "Acme AI", AccountNumber: "MT11SOLANA", BankCode: "CFTEMTM1XXX", BankName: "OpenPayd",
        PaymentMethodID: "Bank/Sepa/EUR/sol", VirtualAccountID: "va2", CryptoCurrency: "EURC_TEST", Network: "SolanaDevnet",
        DestinationAddress: { Address: options.returned ?? SOLANA },
      }));
    }
    if (path.startsWith("/transactions")) return new Response(JSON.stringify({ Items: [{ ID: "t2", PublicID: SIG, Created: "2026-11-11T05:00:00Z", Status: "Settled", Direction: "Out", Amount: "5", CryptoCurrency: "EURC_TEST", Network: "SolanaDevnet" }] }));
    if (path.startsWith("/sandbox/")) return new Response(JSON.stringify({ FiatDepositID: "dep2" }));
    return new Response("{}", { status: 201 });
  });
  const rows = new Map<string, Record<string, unknown>>([["noah", { provider: "noah", customerId: "eut-abc", paymentMethodId: "Bank/Sepa/EUR/base", sandbox: true, iban: "MT49", bic: "B", bankName: "OpenPayd", accountHolder: "Acme AI", cryptoCurrency: "EURC_TEST", network: "BaseTestSepolia", destinationAddress: "0x9435c2d547099D9cd9c82e29290753b590a8aF1e", chainId: 84532 }]]);
  const prisma = {
    bankAccount: {
      findFirst: async ({ where }: { where: { provider: string } }) => { const row = rows.get(where.provider); return row ? { ...row, createdAt: new Date() } : null; },
      create: async ({ data }: { data: Record<string, unknown> }) => { rows.set(String(data.provider), data); return data; },
    },
  } as unknown as PrismaClient;
  const noah = new NoahClient({ apiUrl: "https://api.sandbox.noah.com/v1", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
  const service = new BankService({
    prisma, noah, retryDelayMs: 0,
    companyWallet: async () => ({ address: "0x9435c2d547099D9cd9c82e29290753b590a8aF1e", chainId: 84532, vaultAccountId: "acme.euthyna-nomos.testnet" }),
    solanaWallet: async () => (options.solana === null ? null : { address: options.solana ?? SOLANA, vaultAccountId: "acme.euthyna-nomos.testnet" }),
  });
  return { service, calls, rows };
}

describe("euros on Solana (Noah EURC)", () => {
  it("opens a second IBAN that settles EURC into the Solana wallet read from the vault", async () => {
    const { service, calls } = setup();
    const view = await service.openSolana("org-1");
    expect(calls.find((call) => call.path.startsWith("/workflows/"))!.body).toEqual({
      CustomerID: "eut-abc", FiatCurrency: "EUR", CryptoCurrency: "EURC_TEST", Network: "SolanaDevnet", DestinationAddress: { Address: SOLANA },
    });
    expect(view.account?.iban).toBe("MT49");
    expect(view.solana).toMatchObject({ iban: "MT11SOLANA", destinationAddress: SOLANA, network: "SolanaDevnet" });
    expect(view.transfers[0]).toMatchObject({ txHash: SIG, explorer: `https://explorer.solana.com/tx/${SIG}?cluster=devnet` });
  });

  it("a simulated transfer goes to the Solana IBAN when asked", async () => {
    const { service, calls } = setup();
    await service.openSolana("org-1");
    await service.simulateDeposit("org-1", "5", "solana");
    expect(calls.find((call) => call.path.startsWith("/sandbox/"))!.body).toMatchObject({ PaymentMethodID: "Bank/Sepa/EUR/sol", FiatAmount: "5" });
  });

  it("saves nothing when the partner settles elsewhere, and needs the Solana wallet", async () => {
    const other = setup({ returned: "11111111111111111111111111111111" });
    await expect(other.service.openSolana("org-1")).rejects.toMatchObject({ code: "destination_mismatch" });
    expect(other.rows.has("noah-solana")).toBe(false);
    await expect(setup({ solana: null }).service.openSolana("org-1")).rejects.toMatchObject({ code: "solana_wallet_missing" });
  });
});
