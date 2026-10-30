import { describe, expect, it } from "vitest";

import { assertBoundTo, identityHash, PassportError, RECOVERY_SCOPE, ZkPassportVerifier } from "./passport.js";

const evidence = (asked: string, proved: string) => ({ proofs: [{}], query: { bind: { custom_data: asked } }, result: { bind: { custom_data: proved } } });

describe("ZKPassport evidence", () => {
  it("must be bound to the account it is used for, in the query and in the proved result", () => {
    expect(() => assertBoundTo(evidence("near:bob.testnet", "near:bob.testnet"), "bob.testnet")).not.toThrow();
    for (const [asked, proved] of [["near:eve.testnet", "near:eve.testnet"], ["near:bob.testnet", "near:eve.testnet"], ["near:eve.testnet", "near:bob.testnet"]]) {
      expect(() => assertBoundTo(evidence(asked!, proved!), "bob.testnet")).toThrow(PassportError);
    }
    expect(() => assertBoundTo({ ...evidence("near:bob.testnet", "near:bob.testnet"), proofs: [] }, "bob.testnet")).toThrow(/missing/);
  });

  it("stores only a scoped hash of the identifier", () => {
    expect(identityHash("1")).toMatch(/^[0-9a-f]{64}$/);
    expect(identityHash("1")).not.toBe(identityHash("1", "other-scope"));
    expect(RECOVERY_SCOPE).toBe("euthyna-recovery");
  });

  it("loads the SDK and refuses proofs that are not bound before any cryptography", async () => {
    const verifier = new ZkPassportVerifier({ domain: "euthyna.io", devMode: true });
    await expect(verifier.verify(evidence("near:eve.testnet", "near:eve.testnet"), "bob.testnet")).rejects.toMatchObject({ code: "passport_not_bound" });
  });
});
