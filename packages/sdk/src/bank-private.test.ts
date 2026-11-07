import { readFileSync, writeFileSync } from "node:fs";
import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

import { beneficiaryCommitment, beneficiaryCommitmentV2, beneficiaryVote, canonicalJson, payeeVote, railForm, readBeneficiary, readPayee, sealForSigner, sealV2ForSigner } from "./bank-private.js";
import { publicKeyBase64 } from "./sealed-orders.js";

const FIXTURE = new URL("./fixtures/bank-sealed.json", import.meta.url);
const FIXTURE_V2 = new URL("./fixtures/bank-sealed-v2.json", import.meta.url);
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

  it("seals a Pix payee for the enclave exactly as bank-signer opens it (shared vector, v2)", async () => {
    const { form } = railForm("pix", { firstName: "Ana", lastName: "Souza", pixType: "Email", pixKey: "ana@example.com" });
    const value = { vault: VAULT, channel_id: "a66e5007-3965-51d4-8b34-73eaf3590c05", form, salt: "cd".repeat(32) };
    const sealed = await sealV2ForSigner(value, await testBoxKey(), { ephemeral: new Uint8Array(32).fill(8), iv: new Uint8Array(12).fill(10) });
    const vector = { vault: VAULT, sealed, commitment: beneficiaryCommitmentV2(VAULT, value.channel_id, form, value.salt), form: canonicalJson(form) };
    if (process.env.WRITE_FIXTURES === "1") writeFileSync(FIXTURE_V2, `${JSON.stringify(vector, null, 2)}\n`);
    expect(JSON.parse(readFileSync(FIXTURE_V2, "utf8"))).toEqual(vector);
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it("a payee on another rail: nothing readable in the vote, members read it", async () => {
    const memberKey = new Uint8Array(32).fill(4);
    const readers = [{ account: "alice.testnet", publicKey: publicKeyBase64(x25519.getPublicKey(memberKey)) }];
    const vote = await payeeVote({ vault: VAULT, rail: "uk", channelId: "6c784124-3170-4413-a179-87b0e04a3f47", values: { name: "Tom Baker", holderType: "Individual", sortCode: "04-00-04", account: "12345678", bankName: "Monzo", purpose: "SALARY" }, boxKeyHex: await testBoxKey(), readers });
    const onChain = JSON.stringify([vote.commitment, vote.sealedForSigner, vote.sealedForMembers]);
    for (const secret of ["Baker", "12345678", "040004", "Monzo"]) expect(onChain).not.toContain(secret);
    expect(await readPayee(vote.sealedForMembers, vote.commitment, "alice.testnet", memberKey)).toMatchObject({ name: "Tom Baker", rail: "uk", currency: "GBP", account: "1234 … 5678" });
    await expect(payeeVote({ vault: VAULT, rail: "ach", channelId: "dd1045e1-8d54-5a10-bbe6-f1aaae446d10", values: { name: "X", routing: "12" }, boxKeyHex: await testBoxKey(), readers })).rejects.toThrow(/routing/);
  });
});
