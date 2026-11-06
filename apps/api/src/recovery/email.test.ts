import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { accountInSubject, circuitInputs, dkimKeyHash, newSalt, PUBLIC_INPUT_COUNT, publicInputBytes, readPublicInputs, recoverySubject } from "@euthyna/sdk/email-proof";
import { describe, expect, it } from "vitest";

import { dkimKeys } from "./email.js";

/** A real email (iCloud, from zk-email's test data) proved with the circuit: subject "Hello". */
const icloud = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/icloud-hello.proof.json"), "utf8")) as { proof: string; publicInputs: string[]; selector: string };

describe("ZK Email evidence", () => {
  it("reads what a real proof states: domain, subject, a salted hash of the sender", () => {
    expect(icloud.publicInputs).toHaveLength(PUBLIC_INPUT_COUNT);
    const stated = readPublicInputs(icloud.publicInputs);
    expect(stated.domain).toBe("icloud.com");
    expect(stated.subject).toBe("Hello");
    expect(stated.addressHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stated.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(publicInputBytes(icloud.publicInputs)).toHaveLength(PUBLIC_INPUT_COUNT * 32);
  });

  it("binds a subject to one action and one account", () => {
    expect(recoverySubject("enroll", "alice.testnet")).toBe("Euthyna enroll near:alice.testnet");
    expect(accountInSubject("euthyna ENROLL near:alice.testnet ", "enroll")).toBe("alice.testnet");
    expect(accountInSubject("Euthyna enroll near:alice.testnet", "recovery")).toBeNull();
    expect(accountInSubject("Re: Euthyna enroll near:alice.testnet", "enroll")).toBeNull();
    expect(accountInSubject("Euthyna enroll near:alice.testnet and more", "enroll")).toBeNull();
  });

  it("makes salts below the field modulus and hashes DKIM keys as the contract does", async () => {
    const salt = newSalt();
    expect(salt).toMatch(/^0x[0-9a-f]{62}$/);
    expect(newSalt()).not.toBe(salt);
    const hash = await dkimKeyHash((1n << 2047n) + 12345n);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await dkimKeyHash((1n << 2047n) + 12345n)).toBe(hash);
  });

  it("builds the circuit inputs from a real DKIM-signed email", () => {
    const eml = readFileSync(resolve(import.meta.dirname, "fixtures/icloud-hello.eml"), "latin1");
    const { inputs, domain, selector } = circuitInputs(eml, 1n << 2047n, "0x01");
    expect({ domain, selector, len: inputs.header.len, salt: inputs.salt }).toEqual({ domain: "icloud.com", selector: "1a1hai", len: "472", salt: "0x01" });
    expect(inputs.header.storage).toHaveLength(1024);
  });

  it("gives the same inputs for a pasted source (LF line ends) as for a downloaded .eml (CRLF)", () => {
    const pasted = readFileSync(resolve(import.meta.dirname, "fixtures/icloud-hello.eml"), "latin1");
    const downloaded = pasted.replace(/\r?\n/g, "\r\n");
    expect(pasted).not.toContain("\r");
    expect(downloaded).toContain("\r\n");
    expect(circuitInputs(pasted, 1n << 2047n, "0x01").inputs).toEqual(circuitInputs(downloaded, 1n << 2047n, "0x01").inputs);
  });

  it("takes test DKIM keys only for the names configured", async () => {
    const keys = dkimKeys({ testKeys: { "s._domainkey.test.dev": "v=DKIM1; k=rsa; p=AAAA" }, fetcher: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    await expect(keys("test.dev", "s")).resolves.toEqual(["v=DKIM1; k=rsa; p=AAAA"]);
    await expect(keys("bad domain", "s")).resolves.toEqual([]);
  });
});
