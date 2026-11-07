/**
 * Noah Business API (docs.noah.com): a euro account (IBAN) per company whose deposits settle as a
 * stablecoin into an on-chain address. The API key stays on the server; it never reaches a browser.
 */
export type NoahConfig = { apiUrl: string; apiKey: string; fetch?: typeof fetch };

export class NoahError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type NoahBusiness = {
  registeredName: string;
  registrationNumber: string;
  entityType: string;
  country: string;
  street: string;
  city: string;
  postCode: string;
  state: string;
  incorporationDate: string;
  taxId: string;
  email?: string | undefined;
};

export type NoahVirtualAccount = {
  AccountHolderName: string;
  AccountNumber: string;
  BankCode: string;
  BankName: string;
  PaymentMethodID: string;
  VirtualAccountID: string;
  CryptoCurrency: string;
  Network: string;
  DestinationAddress: { Address: string };
};

export type NoahTransaction = {
  ID: string;
  PublicID?: string;
  Created: string;
  Status: string;
  Direction: "In" | "Out" | string;
  Amount: string;
  CryptoCurrency: string;
  Network: string;
  DestinationAddress?: { Address?: string } | null;
};

export class NoahClient {
  readonly sandbox: boolean;

  constructor(private readonly config: NoahConfig) {
    this.sandbox = new URL(config.apiUrl).hostname.includes("sandbox");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await (this.config.fetch ?? fetch)(`${this.config.apiUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: { "X-Api-Key": this.config.apiKey, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      // Noah's error body names the invalid fields; it never contains the key.
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { Detail?: string; RequestExtension?: { Body?: Array<{ Field?: string; Description?: string }> } };
        const fields = parsed.RequestExtension?.Body?.map((item) => `${item.Field}: ${item.Description}`).join("; ");
        detail = [parsed.Detail, fields].filter(Boolean).join(": ") || detail;
      } catch {
        // Not JSON: keep the text.
      }
      throw new NoahError(response.status, `Noah ${method} ${path.split("?")[0]} failed (${response.status}): ${detail}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Creates or updates the business customer (reliance model: the platform shares the KYB data). */
  upsertBusiness(customerId: string, business: NoahBusiness): Promise<unknown> {
    return this.call("PUT", `/customers/${encodeURIComponent(customerId)}`, {
      Type: "Business",
      RegisteredName: business.registeredName,
      ...(business.email ? { Email: business.email } : {}),
      RegistrationNumber: business.registrationNumber,
      EntityType: business.entityType,
      RegistrationCountry: business.country,
      RegisteredAddress: { Street: business.street, City: business.city, PostCode: business.postCode, State: business.state, Country: business.country },
      IncorporationDate: business.incorporationDate,
      TaxID: business.taxId,
    });
  }

  customer(customerId: string): Promise<{ Verifications?: { Status?: string } }> {
    return this.call("GET", `/customers/${encodeURIComponent(customerId)}`);
  }

  /** A euro IBAN whose deposits are converted and withdrawn to `address` on `network`. */
  bankDepositToAddress(input: { customerId: string; cryptoCurrency: string; network: string; address: string }): Promise<NoahVirtualAccount> {
    return this.call("POST", "/workflows/bank-deposit-to-onchain-address", {
      CustomerID: input.customerId,
      FiatCurrency: "EUR",
      CryptoCurrency: input.cryptoCurrency,
      Network: input.network,
      DestinationAddress: { Address: input.address },
    });
  }

  transactions(customerId: string, pageSize = 20): Promise<{ Items?: NoahTransaction[] }> {
    return this.call("GET", `/transactions?CustomerID=${encodeURIComponent(customerId)}&PageSize=${pageSize}&SortDirection=DESC`);
  }

  /** Payout channels for a country and currency (SEPA, Pix, ACH, local rails…). */
  sellChannels(input: { country: string; fiatCurrency: string; cryptoCurrency: string }): Promise<{ Items?: Array<{ ID: string; PaymentMethodType: string; Limits?: { MinLimit?: string; MaxLimit?: string }; ProcessingSeconds?: number; Rate?: string }> }> {
    return this.call("GET", `/channels/sell?Country=${encodeURIComponent(input.country)}&FiatCurrency=${encodeURIComponent(input.fiatCurrency)}&CryptoCurrency=${encodeURIComponent(input.cryptoCurrency)}`);
  }

  /** Sandbox only: an incoming SEPA transfer on the IBAN. */
  simulateDeposit(paymentMethodId: string, amount: string, reference?: string): Promise<{ FiatDepositID: string }> {
    if (!this.sandbox) throw new NoahError(400, "deposits can be simulated only in Noah's sandbox");
    return this.call("POST", "/sandbox/fiat-deposit/simulate", { PaymentMethodID: paymentMethodId, FiatAmount: amount, FiatCurrency: "EUR", ...(reference ? { Reference: reference } : {}) });
  }
}
