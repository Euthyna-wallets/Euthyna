/**
 * Founder seat recovery. The recovery contract on NEAR (contracts/email-recovery) holds the
 * truth: it verifies the ZK Email proofs, keeps the enrollments, opens a recovery and runs
 * the waiting period during which the lost account can cancel. The browser talks to it
 * directly, with the founder's or the new account's wallet.
 *
 * Here: reading it for the console, the DKIM records the browser needs to build a proof, and
 * drafting the members' vote once a recovery is ready. Nothing here changes a seat by itself:
 * the founders' vote does, with its veto window.
 */
import type { DkimKeySource } from "./email.js";

export class RecoveryError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 422, readonly code: string, message: string) {
    super(message);
  }
}

export interface RecoveryDeps {
  /** The recovery contract's account. */
  contractId: string;
  /** A view call on that contract. */
  view<T>(method: string, args: Record<string, unknown>): Promise<T>;
  /** The company's DAO, once its treasury is active. */
  daoOf(organizationId: string): Promise<string | null>;
  /** The DAO members of a company, as on chain. */
  councilOf(organizationId: string): Promise<string[]>;
  /** Drops the kept lists of enrollments and requests (a page was reloaded). */
  forgetLists?(): void;
  /** The council for a screen (may be a few seconds old). Defaults to `councilOf`. */
  councilShown?(organizationId: string): Promise<string[]>;
  /** Draft the votes that set these members (DAO policy and vault council). */
  membersProposals(organizationId: string, members: string[]): Promise<{ proposals: unknown[] }>;
}

type ChainEnrollment = { account_id: string; salt: string; identity: string; domain: string; enrolled_at_ns: string };
type ChainRecovery = {
  lost_account_id: string; new_account_id: string; domain: string; requested_at_ns: string; not_before_ns: string;
  state: "Waiting" | "Cancelled"; ready: boolean;
};

const iso = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();

export class RecoveryService {
  constructor(private readonly deps: RecoveryDeps, private readonly keys: DkimKeySource = async () => []) {}

  /** DKIM records the browser needs to build a proof; the contract only accepts keys it knows. */
  async dkimRecords(domain: string, selector: string) {
    return this.keys(domain, selector);
  }

  private async dao(organizationId: string) {
    const dao = await this.deps.daoOf(organizationId);
    if (!dao) throw new RecoveryError(404, "company_not_found", "this company has no active DAO");
    return dao;
  }

  /** A reloaded page reads the contract again. */
  forgetLists(): void {
    this.deps.forgetLists?.();
  }

  /** Enrolled founders and recoveries, as the contract has them. A voted recovery shows as done. */
  async list(organizationId: string) {
    const dao = await this.dao(organizationId);
    const [enrollments, recoveries, delay, council] = await Promise.all([
      this.deps.view<ChainEnrollment[]>("enrollments_of", { dao_id: dao }),
      this.deps.view<ChainRecovery[]>("recoveries_of", { dao_id: dao }),
      this.deps.view<string>("delay_seconds", {}),
      (this.deps.councilShown ?? this.deps.councilOf)(organizationId),
    ]);
    return {
      contractId: this.deps.contractId,
      daoAccountId: dao,
      cancelWindowSeconds: Number(delay),
      enrollments: enrollments.map((item) => ({ nearAccountId: item.account_id, domain: item.domain, enrolledAt: iso(item.enrolled_at_ns) })),
      recoveries: [...recoveries].reverse().map((item) => {
        const done = council.includes(item.new_account_id) && !council.includes(item.lost_account_id);
        return {
          lostAccountId: item.lost_account_id,
          newAccountId: item.new_account_id,
          domain: item.domain,
          state: item.state === "Cancelled" ? "cancelled" : done ? "done" : "waiting",
          ready: item.ready && !done,
          notBefore: iso(item.not_before_ns),
          requestedAt: iso(item.requested_at_ns),
        };
      }),
    };
  }

  /** After the waiting period: the votes that replace the lost account by the new one. */
  async proposals(organizationId: string, lostAccountId: string) {
    const dao = await this.dao(organizationId);
    const recovery = await this.deps.view<ChainRecovery | null>("recovery", { dao_id: dao, lost_account_id: lostAccountId });
    if (!recovery) throw new RecoveryError(404, "recovery_not_found", `no open recovery of ${lostAccountId}'s seat`);
    if (!recovery.ready) throw new RecoveryError(409, "too_early", `the founder can still cancel until ${iso(recovery.not_before_ns)}`);
    const council = await this.deps.councilOf(organizationId);
    if (!council.includes(lostAccountId)) throw new RecoveryError(409, "seat_changed", `${lostAccountId} is no longer a member`);
    if (council.includes(recovery.new_account_id)) throw new RecoveryError(409, "already_a_founder", `${recovery.new_account_id} is already a member`);
    const members = council.map((member) => (member === lostAccountId ? recovery.new_account_id : member));
    return this.deps.membersProposals(organizationId, members);
  }
}
