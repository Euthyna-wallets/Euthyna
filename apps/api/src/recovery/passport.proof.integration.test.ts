/**
 * A real ZKPassport proof (made by the phone app in developer mode, mock ID), through the
 * real verifier: SDK checks against the Sepolia registries. ZKPASSPORT_PROOF=<file> ZKPASSPORT_ACCOUNT=<account>
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { identityHash, ZkPassportVerifier, type PassportEvidence } from "./passport.js";

const file = process.env.ZKPASSPORT_PROOF;
const account = process.env.ZKPASSPORT_ACCOUNT;

describe.skipIf(!file || !account)("a real ZKPassport proof", () => {
  it("verifies for the account it is bound to, and for no other", async () => {
    const evidence = JSON.parse(readFileSync(file!, "utf8")) as PassportEvidence;
    const verifier = new ZkPassportVerifier({ domain: "euthyna.io", devMode: true, sepoliaRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com" });
    const verified = await verifier.verify(evidence, account!);
    // Mock IDs all share the identifier 1 (ZKPassport docs).
    expect(verified).toEqual({ identityHash: identityHash("1"), devMode: true });
    await expect(verifier.verify(evidence, "someone-else.testnet")).rejects.toMatchObject({ code: "passport_not_bound" });
    // The same proof, not in dev mode (mainnet): refused.
    await expect(new ZkPassportVerifier({ domain: "euthyna.io", devMode: false }).verify(evidence, account!)).rejects.toMatchObject({ code: "passport_invalid" });
  }, 120_000);
});
