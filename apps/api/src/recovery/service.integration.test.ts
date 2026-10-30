/**
 * Seat recovery against PostgreSQL, with a stand-in for the ZK verifier (the real one is
 * covered by passport.test.ts and, with a proof made by the ZKPassport app, by
 * passport.proof.integration.test.ts). TEST_DATABASE_URL=… vitest run src/recovery
 */
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@mandateos/db";
import { afterAll, describe, expect, it } from "vitest";

import { assertBoundTo, identityHash, type PassportEvidence, type PassportVerifier } from "./passport.js";
import { RecoveryService } from "./service.js";

const url = process.env.TEST_DATABASE_URL;

/** The ID is evidence.result.id; the binding checks are the real ones. */
const verifier: PassportVerifier = {
  async verify(evidence: PassportEvidence, account: string) {
    assertBoundTo(evidence, account);
    return { identityHash: identityHash(String(evidence.result.id)), devMode: true };
  },
};
const proof = (account: string, id: string): PassportEvidence => ({ proofs: [{ name: "outer" }], query: { bind: { custom_data: `near:${account}` } }, result: { id, bind: { custom_data: `near:${account}` } } });

describe.skipIf(!url)("founder seat recovery", () => {
  // describe.skipIf still runs this body: build the client only with a database.
  const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as unknown as PrismaClient);
  const org = randomUUID();
  const dao = `co-${org.slice(0, 8)}.sputnikv2.testnet`;
  let council = ["alice.testnet", "bob.testnet", "carol.testnet"];
  let now = new Date("2026-11-01T10:00:00Z");
  const drafted: string[][] = [];
  const service = new RecoveryService(prisma, verifier, {
    councilOf: async () => council,
    organizationOfDao: async (account) => (account === dao ? org : null),
    membersProposals: async (_org, members) => { drafted.push(members); return { proposals: [{ title: "policy" }, { title: "council" }] }; },
  }, 48 * 3600_000, () => now);

  afterAll(async () => {
    if (!url) return;
    await prisma.organization.delete({ where: { id: org } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("replaces a lost founder by a vote, only with the enrolled ID, after the cancel window", async () => {
    await prisma.organization.create({ data: { id: org, name: "Recovery Co", slug: `recovery-${org.slice(0, 8)}`, createdAt: new Date() } });
    await expect(service.enroll(org, "eve.testnet", proof("eve.testnet", "eve-id"))).rejects.toMatchObject({ code: "not_a_founder" });
    await expect(service.enroll(org, "carol.testnet", proof("bob.testnet", "carol-id"))).rejects.toMatchObject({ code: "passport_not_bound" });
    await expect(service.enroll(org, "carol.testnet", proof("carol.testnet", "carol-id"))).resolves.toEqual({ enrolled: "carol.testnet", devMode: true });

    const ask = (newAccount: string, id: string, lost = "carol.testnet") => service.request({ daoAccountId: dao, lostAccountId: lost, newAccount, evidence: proof(newAccount, id) });
    await expect(ask("mallory.testnet", "mallory-id")).rejects.toMatchObject({ code: "different_id" });
    await expect(ask("carol2.testnet", "carol-id", "bob.testnet")).rejects.toMatchObject({ code: "not_enrolled" });
    await expect(ask("bob.testnet", "carol-id")).rejects.toMatchObject({ code: "already_a_founder" });
    // A proof bound to another account cannot be reused for this one.
    await expect(service.request({ daoAccountId: dao, lostAccountId: "carol.testnet", newAccount: "carol2.testnet", evidence: proof("mallory.testnet", "carol-id") })).rejects.toMatchObject({ code: "passport_not_bound" });

    const recovery = await ask("carol2.testnet", "carol-id");
    expect(recovery).toMatchObject({ state: "waiting", lostAccountId: "carol.testnet", newAccountId: "carol2.testnet", notBefore: "2026-11-03T10:00:00.000Z" });
    await expect(ask("carol3.testnet", "carol-id")).rejects.toMatchObject({ code: "recovery_open" });
    await expect(service.proposals(org, recovery.id)).rejects.toMatchObject({ code: "too_early" });
    await expect(service.cancel(org, recovery.id, "bob.testnet")).rejects.toMatchObject({ code: "not_the_founder" });

    now = new Date("2026-11-03T10:00:01Z");
    const { proposals } = await service.proposals(org, recovery.id);
    expect(proposals).toHaveLength(2);
    expect(drafted.at(-1)).toEqual(["alice.testnet", "bob.testnet", "carol2.testnet"]);
    // The members voted: the DAO now has carol2, not carol.
    council = ["alice.testnet", "bob.testnet", "carol2.testnet"];
    const listed = await service.list(org);
    expect(listed.recoveries[0]).toMatchObject({ id: recovery.id, state: "done" });
    expect(listed.enrollments).toEqual([expect.objectContaining({ nearAccountId: "carol.testnet" })]);
    const evidence = await service.evidence(org, recovery.id);
    expect(evidence.enrollmentEvidence).toBeTruthy();
  });

  it("lets the founder who still holds the account cancel a recovery they did not ask for", async () => {
    council = ["alice.testnet", "bob.testnet", "carol.testnet"];
    now = new Date("2026-11-10T10:00:00Z");
    await service.enroll(org, "alice.testnet", proof("alice.testnet", "alice-id"));
    // Someone with Alice's passport (stolen) tries to take her seat.
    const theft = await service.request({ daoAccountId: dao, lostAccountId: "alice.testnet", newAccount: "thief.testnet", evidence: proof("thief.testnet", "alice-id") });
    await expect(service.cancel(org, theft.id, "alice.testnet")).resolves.toMatchObject({ state: "cancelled", cancelledBy: "alice.testnet" });
    now = new Date("2026-11-20T10:00:00Z");
    await expect(service.proposals(org, theft.id)).rejects.toMatchObject({ code: "recovery_closed" });
  });
});
