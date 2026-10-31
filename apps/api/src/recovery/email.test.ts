import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { accountInSubject, circuitInputs, PUBLIC_INPUT_COUNT, readPublicInputs, recoverySubject } from "@mandateos/sdk/email-proof";
import { describe, expect, it } from "vitest";

import { dkimKeys, EmailVerifier, parseEvidence } from "./email.js";

/** A real email (iCloud, from zk-email's test data) proved with the circuit: subject "Hello". */
const icloud = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/icloud-hello.proof.json"), "utf8")) as { proof: string; publicInputs: string[]; selector: string };

describe("ZK Email evidence", () => {
  it("reads what a real proof states: domain, subject, a hash of the sender", () => {
    expect(icloud.publicInputs).toHaveLength(PUBLIC_INPUT_COUNT);
    const stated = readPublicInputs(icloud.publicInputs);
    expect(stated.domain).toBe("icloud.com");
    expect(stated.subject).toBe("Hello");
    expect(stated.addressHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds a subject to one action and one account", () => {
    expect(recoverySubject("enroll", "alice.testnet")).toBe("Euthyna enroll near:alice.testnet");
    expect(accountInSubject("euthyna ENROLL near:alice.testnet ", "enroll")).toBe("alice.testnet");
    expect(accountInSubject("Euthyna enroll near:alice.testnet", "recovery")).toBeNull();
    expect(accountInSubject("Re: Euthyna enroll near:alice.testnet", "enroll")).toBeNull();
    expect(accountInSubject("Euthyna enroll near:alice.testnet and more", "enroll")).toBeNull();
  });

  it("refuses malformed evidence and emails that do not name the account", async () => {
    expect(() => parseEvidence({ proof: 1 })).toThrow();
    expect(() => parseEvidence({ ...icloud, publicInputs: ["nope"] })).toThrow();
    const verifier = new EmailVerifier(async () => []);
    await expect(verifier.verify(icloud, "alice.testnet", "enroll")).rejects.toMatchObject({ code: "email_not_bound" });
  });

  it("builds the circuit inputs from a real DKIM-signed email", () => {
    const eml = readFileSync(resolve(import.meta.dirname, "fixtures/icloud-hello.eml"), "latin1");
    const { inputs, domain, selector } = circuitInputs(eml, 1n << 2047n);
    expect({ domain, selector, len: inputs.header.len }).toEqual({ domain: "icloud.com", selector: "1a1hai", len: "472" });
    expect(inputs.header.storage).toHaveLength(1024);
  });

  it("gives the same inputs for a pasted source (LF line ends) as for a downloaded .eml (CRLF)", () => {
    const pasted = readFileSync(resolve(import.meta.dirname, "fixtures/icloud-hello.eml"), "latin1");
    const downloaded = pasted.replace(/\r?\n/g, "\r\n");
    expect(pasted).not.toContain("\r");
    expect(downloaded).toContain("\r\n");
    expect(circuitInputs(pasted, 1n << 2047n).inputs).toEqual(circuitInputs(downloaded, 1n << 2047n).inputs);
  });

  it("takes test DKIM keys only for the names configured", async () => {
    const keys = dkimKeys({ testKeys: { "s._domainkey.test.dev": "v=DKIM1; k=rsa; p=AAAA" }, fetcher: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    await expect(keys("test.dev", "s")).resolves.toEqual(["v=DKIM1; k=rsa; p=AAAA"]);
    await expect(keys("bad domain", "s")).resolves.toEqual([]);
  });
});
