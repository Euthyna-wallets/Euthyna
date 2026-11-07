import type { PrismaClient } from "@euthyna/db";

import { type NoahBusiness, type NoahClient, NoahError } from "./noah.js";

export class BankError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, readonly code: string, message: string) {
    super(message);
  }
}

/** Where the euro settles, per chain: Noah's sandbox euro on Base Sepolia, EURC on Base. */
const SETTLEMENT: Record<number, { sandbox: { network: string; cryptoCurrency: string } | null; production: { network: string; cryptoCurrency: string } | null; explorer: string }> = {
  84532: { sandbox: { network: "BaseTestSepolia", cryptoCurrency: "EURC_TEST" }, production: null, explorer: "https://sepolia.basescan.org/tx/" },
  8453: { sandbox: null, production: { network: "Base", cryptoCurrency: "EURC" }, explorer: "https://basescan.org/tx/" },
};

export type BankDeps = {
  prisma: PrismaClient;
  noah: NoahClient;
  /** The company wallet the vault controls (read from the vault on NEAR), or null before it exists. */
  companyWallet: (organizationId: string) => Promise<{ address: string; chainId: number } | null>;
};

export type BankView = {
  sandbox: boolean;
  account: null | {
    iban: string;
    bic: string;
    bankName: string;
    accountHolder: string;
    currency: "EUR";
    settlesAs: string;
    network: string;
    destinationAddress: string;
    createdAt: string;
  };
  transfers: Array<{ id: string; created: string; status: string; direction: "in" | "out"; amount: string; currency: string; network: string; txHash: string | null; explorer: string | null }>;
};

const customerIdOf = (organizationId: string) => `euthyna-${organizationId}`.slice(0, 64);

/**
 * A company's euro account. Its deposits can only settle into the company wallet: the address is
 * read from the vault here, never taken from the request, so no member can redirect the IBAN.
 */
export class BankService {
  constructor(private readonly deps: BankDeps) {}

  async view(organizationId: string): Promise<BankView> {
    const account = await this.deps.prisma.bankAccount.findFirst({ where: { organizationId, provider: "noah" } });
    if (!account) return { sandbox: this.deps.noah.sandbox, account: null, transfers: [] };
    const explorer = SETTLEMENT[account.chainId]?.explorer ?? null;
    const items = (await this.deps.noah.transactions(account.customerId).catch(() => ({ Items: [] }))).Items ?? [];
    return {
      sandbox: account.sandbox,
      account: {
        iban: account.iban,
        bic: account.bic,
        bankName: account.bankName,
        accountHolder: account.accountHolder,
        currency: "EUR",
        settlesAs: account.cryptoCurrency,
        network: account.network,
        destinationAddress: account.destinationAddress,
        createdAt: account.createdAt.toISOString(),
      },
      transfers: items.map((item) => {
        const onchain = item.PublicID && /^0x[0-9a-fA-F]{64}$/.test(item.PublicID) ? item.PublicID : null;
        return {
          id: item.ID,
          created: item.Created,
          status: item.Status,
          direction: item.Direction === "Out" ? "out" : "in",
          amount: item.Amount,
          currency: item.CryptoCurrency,
          network: item.Network,
          txHash: onchain,
          explorer: onchain && explorer ? `${explorer}${onchain}` : null,
        };
      }),
    };
  }

  async open(organizationId: string, business: NoahBusiness): Promise<BankView> {
    const existing = await this.deps.prisma.bankAccount.findFirst({ where: { organizationId, provider: "noah" } });
    if (existing) throw new BankError(409, "bank_account_exists", "this company already has a euro account");
    const wallet = await this.deps.companyWallet(organizationId);
    if (!wallet) throw new BankError(409, "wallet_missing", "open the company wallet first: deposits settle into it");
    const settlement = SETTLEMENT[wallet.chainId]?.[this.deps.noah.sandbox ? "sandbox" : "production"];
    if (!settlement) throw new BankError(409, "chain_unsupported", `euro deposits cannot settle on chain ${wallet.chainId} here`);
    const customerId = customerIdOf(organizationId);
    try {
      await this.deps.noah.upsertBusiness(customerId, business);
      const account = await this.deps.noah.bankDepositToAddress({ customerId, ...settlement, address: wallet.address });
      if (account.DestinationAddress.Address.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new BankError(502, "destination_mismatch", "the partner returned another settlement address; nothing was saved");
      }
      await this.deps.prisma.bankAccount.create({
        data: {
          organizationId,
          provider: "noah",
          sandbox: this.deps.noah.sandbox,
          customerId,
          virtualAccountId: account.VirtualAccountID,
          paymentMethodId: account.PaymentMethodID,
          iban: account.AccountNumber,
          bic: account.BankCode,
          bankName: account.BankName,
          accountHolder: account.AccountHolderName,
          fiatCurrency: "EUR",
          cryptoCurrency: account.CryptoCurrency,
          network: account.Network,
          destinationAddress: wallet.address,
          chainId: wallet.chainId,
        },
      });
    } catch (error) {
      if (error instanceof NoahError) throw new BankError(error.status >= 500 ? 502 : 400, "partner_refused", error.message);
      throw error;
    }
    return this.view(organizationId);
  }

  /** Sandbox only: a SEPA transfer arrives on the IBAN. */
  async simulateDeposit(organizationId: string, amount: string): Promise<{ depositId: string }> {
    const account = await this.deps.prisma.bankAccount.findFirst({ where: { organizationId, provider: "noah" } });
    if (!account) throw new BankError(404, "bank_account_missing", "this company has no euro account yet");
    if (!account.sandbox || !this.deps.noah.sandbox) throw new BankError(400, "not_sandbox", "transfers can be simulated only in the sandbox");
    try {
      const result = await this.deps.noah.simulateDeposit(account.paymentMethodId, amount);
      return { depositId: result.FiatDepositID };
    } catch (error) {
      if (error instanceof NoahError) throw new BankError(error.status >= 500 ? 502 : 400, "partner_refused", error.message);
      throw error;
    }
  }
}
