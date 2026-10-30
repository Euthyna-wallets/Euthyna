/**
 * ZKPassport proofs for founder seat recovery. A proof says "the holder of this ID",
 * bound to one NEAR account (`near:<account>` in the bound data): it is useless to
 * anyone else. Only a hash of the scoped unique identifier is ever stored.
 *
 * Verified locally with the SDK's bundled verifier (never ZKPassport's API), against
 * the certificate and circuit registries on Ethereum Sepolia. Dev mode accepts mock
 * IDs (issuer ZKR) and is for testnet only.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export const RECOVERY_SCOPE = "euthyna-recovery";

export type PassportEvidence = { proofs: unknown[]; query: Record<string, unknown>; result: Record<string, unknown> };

export interface PassportVerifier {
  /** The identity hash of the ID behind these proofs, bound to `account`; throws when they do not prove it. */
  verify(evidence: PassportEvidence, account: string): Promise<{ identityHash: string; devMode: boolean }>;
}

export class PassportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export const boundTo = (account: string) => `near:${account}`;

export function identityHash(uniqueIdentifier: string, scope = RECOVERY_SCOPE): string {
  return createHash("sha256").update(`${scope}:${uniqueIdentifier}`).digest("hex");
}

/** Checks done before any cryptography: the proofs must be about this account. */
export function assertBoundTo(evidence: PassportEvidence, account: string) {
  const expected = boundTo(account);
  const asked = (evidence.query.bind as { custom_data?: unknown } | undefined)?.custom_data;
  const proved = (evidence.result.bind as { custom_data?: unknown } | undefined)?.custom_data;
  if (asked !== expected || proved !== expected) {
    throw new PassportError("passport_not_bound", `the proof must be bound to ${expected}`);
  }
  if (!Array.isArray(evidence.proofs) || evidence.proofs.length === 0 || evidence.proofs.length > 12) {
    throw new PassportError("passport_invalid", "proofs are missing");
  }
}

type ZkPassportSdk = {
  ZKPassport: new (domain: string) => {
    verify(input: Record<string, unknown>): Promise<{ verified: boolean; uniqueIdentifier?: string; queryResultErrors?: unknown }>;
  };
};

export class ZkPassportVerifier implements PassportVerifier {
  private readonly sdk: ZkPassportSdk;

  constructor(private readonly config: { domain: string; devMode: boolean; sepoliaRpcUrl?: string | undefined }) {
    // The SDK's ESM build imports "buffer/" as a directory, which Node refuses: load its CommonJS build.
    this.sdk = createRequire(import.meta.url)("@zkpassport/sdk") as ZkPassportSdk;
  }

  async verify(evidence: PassportEvidence, account: string) {
    assertBoundTo(evidence, account);
    const zk = new this.sdk.ZKPassport(this.config.domain);
    const outcome = await zk.verify({
      proofs: evidence.proofs,
      originalQuery: evidence.query,
      queryResult: evidence.result,
      scope: RECOVERY_SCOPE,
      devMode: this.config.devMode,
      verifierMode: "local",
      ...(this.config.sepoliaRpcUrl ? { config: { rpcUrl: this.config.sepoliaRpcUrl } } : {}),
    }).catch((error: unknown) => {
      // Details stay in the server log; the caller learns only that the proof failed.
      console.warn(`zkpassport verify failed: ${String(error).slice(0, 300)}`);
      throw new PassportError("passport_invalid", "the proof could not be verified");
    });
    if (!outcome.verified || !outcome.uniqueIdentifier) {
      console.warn(`zkpassport proof rejected: ${JSON.stringify(outcome.queryResultErrors ?? {}).slice(0, 500)}`);
      throw new PassportError("passport_invalid", "the proof is not valid");
    }
    return { identityHash: identityHash(outcome.uniqueIdentifier), devMode: this.config.devMode };
  }
}
