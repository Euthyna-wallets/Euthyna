import { readFileSync, writeFileSync } from "node:fs";
import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

import { beneficiaryCommitment, beneficiaryVote, readBeneficiary, sealForSigner } from "./bank-private.js";
import { publicKeyBase64 } from "./sealed-orders.js";

const FIXTURE = new URL("./fixtures/bank-sealed.json", import.meta.url);
const VAULT = "acme.euthyna-nomos.testnet";

/** The enclave's box key for the test seed (bank-signer tests use "11" × 32). */
async function testBoxKey(): Promise<string> {
  const seed = Uint8Array.from(Buffer.from("11".repeat(32), "hex"));
  const ikm = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("euthyna-bank-signer"), info: new TextEncoder().encode("beneficiary box key v1") }, ikm, 256);
  return Buffer.from(x25519.getPublicKey(new Uint8Array(bits))).toString("hex");
}

describe("private bank beneficiaries", () => {
  it("seals for the enclave exactly as bank-signer opens it (shared vector)", async () => {
    const value = { vault: VAULT, iban: "FR7630006000011234567890189", name: "Atelier Dupont SAS", holder_type: "Business" as const, salt: "ab".repeat(32) };
    const sealed = await sealForSigner(value, await testBoxKey(), { ephemeral: new Uint8Array(32).fill(7), iv: new Uint8Array(12).fill(9) });
    const commitment = beneficiaryCommitment(VAULT, value.iban, value.name, value.holder_type, value.salt);
    const vector = { vault: VAULT, sealed, commitment, plaintext: JSON.stringify(value) };
    if (process.env.WRITE_FIXTURES === "1") writeFileSync(FIXTURE, `${JSON.stringify(vector, null, 2)}\n`);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(vector);
  });

  it("puts only a commitment and envelopes in the vote, and a member reads it back", async () => {
    const memberKey = new Uint8Array(32).fill(3);
    const vote = await beneficiaryVote({
      vault: VAULT, iban: "FR76 3000 6000 0112 3456 7890 189", name: "Atelier Dupont SAS", holderType: "Business",
      boxKeyHex: await testBoxKey(), readers: [{ account: "alice.testnet", publicKey: publicKeyBase64(x25519.getPublicKey(memberKey)) }],
    });
    const onChain = JSON.stringify([vote.commitment, vote.sealedForSigner, vote.sealedForMembers]);
    expect(onChain).not.toContain("FR76");
    expect(onChain).not.toContain("Dupont");
    const read = await readBeneficiary(vote.sealedForMembers, vote.commitment, "alice.testnet", memberKey);
    expect(read).toMatchObject({ iban: "FR7630006000011234567890189", name: "Atelier Dupont SAS", holder_type: "Business" });
    // Another commitment: the member's copy is not accepted as that beneficiary.
    expect(await readBeneficiary(vote.sealedForMembers, "00".repeat(32), "alice.testnet", memberKey)).toBeNull();
    // Two votes for the same IBAN do not share a commitment (fresh salt).
    const again = await beneficiaryVote({ vault: VAULT, iban: "FR7630006000011234567890189", name: "Atelier Dupont SAS", holderType: "Business", boxKeyHex: await testBoxKey(), readers: [{ account: "alice.testnet", publicKey: publicKeyBase64(x25519.getPublicKey(memberKey)) }] });
    expect(again.commitment).not.toBe(vote.commitment);
  });

  it("refuses a bad IBAN before sealing anything", async () => {
    await expect(beneficiaryVote({ vault: VAULT, iban: "FR7630006000011234567890180", name: "X", holderType: "Business", boxKeyHex: await testBoxKey(), readers: [{ account: "a", publicKey: publicKeyBase64(new Uint8Array(32).fill(1)) }] })).rejects.toThrow(/checksum/);
  });
});
