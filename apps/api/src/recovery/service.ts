/**
 * Founder seat recovery. A founder enrolls their mailbox once (a ZK Email proof bound to
 * their NEAR account). If they lose that account, a new account brings a proof from the
 * same mailbox; after a waiting period, during which the lost account can still cancel,
 * the members get the usual vote to replace one by the other (DAO and vault council).
 *
 * Nothing here changes a seat by itself: the founders' vote does, with its veto window.
 */
import type { PrismaClient } from "@mandateos/db";

import type { RecoveryAction } from "@mandateos/sdk/email-proof";

import { IdentityError, type DkimKeySource, type IdentityVerifier } from "./email.js";

export class RecoveryError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 422, readonly code: string, message: string) {
    super(message);
  }
}

export interface RecoveryDeps {
  /** The DAO members of a company, as on chain. */
  councilOf(organizationId: string): Promise<string[]>;
  /** The company whose DAO is this account, with an active treasury. */
  organizationOfDao(daoAccountId: string): Promise<string | null>;
  /** Draft the votes that set these members (DAO policy and vault council). */
  membersProposals(organizationId: string, members: string[]): Promise<{ proposals: unknown[] }>;
}

const MAX_EVIDENCE_BYTES = 1_500_000;

function checkSize(evidence: unknown) {
  if (Buffer.byteLength(JSON.stringify(evidence)) > MAX_EVIDENCE_BYTES) throw new RecoveryError(400, "evidence_too_large", "the proofs are too large");
}

export class RecoveryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly verifier: IdentityVerifier,
    private readonly deps: RecoveryDeps,
    private readonly delayMs: number,
    private readonly now: () => Date = () => new Date(),
    private readonly keys: DkimKeySource = async () => [],
  ) {}

  /** DKIM records the browser needs to build a proof the API will accept. */
  async dkimRecords(domain: string, selector: string) {
    return this.keys(domain, selector);
  }

  private async verify(evidence: unknown, account: string, action: RecoveryAction) {
    checkSize(evidence);
    try {
      return await this.verifier.verify(evidence, account, action);
    } catch (error) {
      if (error instanceof IdentityError) throw new RecoveryError(422, error.code, error.message);
      throw error;
    }
  }

  /** A founder enrolls their mailbox (again to change it: the new proof replaces the old one). */
  async enroll(organizationId: string, member: string | null | undefined, evidence: unknown) {
    if (!member || !(await this.deps.councilOf(organizationId)).includes(member)) {
      throw new RecoveryError(403, "not_a_founder", "only a member of the company's DAO can enroll for seat recovery");
    }
    const { identityHash, method } = await this.verify(evidence, member, "enroll");
    const data = { identityHash, evidence: evidence as never, method };
    await this.prisma.recoveryEnrollment.upsert({
      where: { organizationId_nearAccountId: { organizationId, nearAccountId: member } },
      create: { organizationId, nearAccountId: member, ...data },
      update: { ...data, createdAt: this.now() },
    });
    return { enrolled: member, method };
  }

  /** A new account asks for a lost seat. Signed in as `newAccount`, with a proof from the enrolled mailbox. */
  async request(input: { daoAccountId: string; lostAccountId: string; newAccount: string; evidence: unknown }) {
    const organizationId = await this.deps.organizationOfDao(input.daoAccountId);
    if (!organizationId) throw new RecoveryError(404, "company_not_found", "no active company has this DAO");
    const council = await this.deps.councilOf(organizationId);
    if (!council.includes(input.lostAccountId)) throw new RecoveryError(404, "not_a_founder", `${input.lostAccountId} is not a member of this DAO`);
    if (council.includes(input.newAccount)) throw new RecoveryError(409, "already_a_founder", `${input.newAccount} is already a member`);
    const enrollment = await this.prisma.recoveryEnrollment.findUnique({
      where: { organizationId_nearAccountId: { organizationId, nearAccountId: input.lostAccountId } },
    });
    if (!enrollment) throw new RecoveryError(404, "not_enrolled", `${input.lostAccountId} never enrolled a mailbox for recovery`);
    const { identityHash, method } = await this.verify(input.evidence, input.newAccount, "recovery");
    if (identityHash !== enrollment.identityHash) throw new RecoveryError(403, "different_mailbox", "this email is not from the mailbox the founder enrolled");
    const open = await this.prisma.seatRecovery.findFirst({ where: { organizationId, lostAccountId: input.lostAccountId, state: { in: ["waiting", "proposed"] } } });
    if (open) throw new RecoveryError(409, "recovery_open", "a recovery of this seat is already open");
    const recovery = await this.prisma.seatRecovery.create({
      data: {
        organizationId, lostAccountId: input.lostAccountId, newAccountId: input.newAccount, identityHash,
        evidence: input.evidence as never, method, notBefore: new Date(this.now().getTime() + this.delayMs),
      },
    });
    return view(recovery);
  }

  /** The lost account still works: its holder stops a recovery they did not ask for. */
  async cancel(organizationId: string, id: string, by: string | null | undefined) {
    const recovery = await this.find(organizationId, id);
    if (!by || by !== recovery.lostAccountId) throw new RecoveryError(403, "not_the_founder", "only the account being replaced can cancel");
    if (recovery.state !== "waiting" && recovery.state !== "proposed") throw new RecoveryError(409, "recovery_closed", "this recovery is closed");
    return view(await this.prisma.seatRecovery.update({ where: { id }, data: { state: "cancelled", cancelledBy: by } }));
  }

  /** After the waiting period: the votes that replace the lost account by the new one. */
  async proposals(organizationId: string, id: string) {
    const recovery = await this.find(organizationId, id);
    if (recovery.state !== "waiting" && recovery.state !== "proposed") throw new RecoveryError(409, "recovery_closed", "this recovery is closed");
    if (this.now() < recovery.notBefore) {
      throw new RecoveryError(409, "too_early", `the founder can still cancel until ${recovery.notBefore.toISOString()}`);
    }
    const council = await this.deps.councilOf(organizationId);
    if (!council.includes(recovery.lostAccountId)) throw new RecoveryError(409, "seat_changed", `${recovery.lostAccountId} is no longer a member`);
    const members = council.map((member) => (member === recovery.lostAccountId ? recovery.newAccountId : member));
    const drafts = await this.deps.membersProposals(organizationId, members);
    await this.prisma.seatRecovery.update({ where: { id }, data: { state: "proposed" } });
    return { ...drafts, recovery: view({ ...recovery, state: "proposed" }) };
  }

  /** Enrolled founders and recoveries; a voted recovery shows as done. */
  async list(organizationId: string) {
    const [enrollments, recoveries, council] = await Promise.all([
      this.prisma.recoveryEnrollment.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } }),
      this.prisma.seatRecovery.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 50 }),
      this.deps.councilOf(organizationId),
    ]);
    for (const recovery of recoveries) {
      if (recovery.state === "proposed" && council.includes(recovery.newAccountId) && !council.includes(recovery.lostAccountId)) {
        await this.prisma.seatRecovery.update({ where: { id: recovery.id }, data: { state: "done" } });
        recovery.state = "done";
      }
    }
    return {
      enrollments: enrollments.map((item) => ({ nearAccountId: item.nearAccountId, method: item.method, enrolledAt: item.createdAt.toISOString() })),
      recoveries: recoveries.map(view),
    };
  }

  /** The proofs behind a recovery, for members who check them themselves. */
  async evidence(organizationId: string, id: string) {
    const recovery = await this.find(organizationId, id);
    const enrollment = await this.prisma.recoveryEnrollment.findUnique({
      where: { organizationId_nearAccountId: { organizationId, nearAccountId: recovery.lostAccountId } },
    });
    return { recovery: view(recovery), recoveryEvidence: recovery.evidence, enrollmentEvidence: enrollment?.evidence ?? null };
  }

  private async find(organizationId: string, id: string) {
    const recovery = await this.prisma.seatRecovery.findFirst({ where: { id, organizationId } });
    if (!recovery) throw new RecoveryError(404, "recovery_not_found", "recovery not found");
    return recovery;
  }
}

function view(recovery: { id: string; lostAccountId: string; newAccountId: string; state: string; notBefore: Date; method: string; createdAt: Date; cancelledBy: string | null }) {
  return {
    id: recovery.id, lostAccountId: recovery.lostAccountId, newAccountId: recovery.newAccountId, state: recovery.state,
    notBefore: recovery.notBefore.toISOString(), method: recovery.method, createdAt: recovery.createdAt.toISOString(), cancelledBy: recovery.cancelledBy,
  };
}
