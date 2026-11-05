/**
 * A law forked from somewhere else, pre-filled in the first role of a new company.
 * Today only one: Ruggy's law, from the « Fork Ruggy's law » card of /rob
 * (/onboarding?path=euthyna&law=ruggy). The founders still see every field, can change any of
 * them, and vote on the role as usual: this only chooses what the role builder opens with.
 *
 * The choice survives the setup steps (company creation clears the URL, the wallet and the vote
 * take several visits): it is kept in this browser, first for the visit, then for the company.
 */

/** A NEAR token-transfer block, in the role builder's draft shape (RolesPage, kind "near-transfer"). */
export type ForkedNearBlock = {
  kind: "near-transfer";
  token: string;
  receivers: Array<{ accountId: string; label: string }>;
  amount: string;
  periodDays: number;
  maxPerTransfer: string;
  minPerTransfer: string;
};

export type ForkedLaw = {
  id: "ruggy";
  /** The banner on the onboarding. */
  banner: string;
  /** The rules, in a line each. */
  rules: string[];
  hint: string;
  block: ForkedNearBlock;
};

/**
 * Ruggy's law (docs/rob-the-agent.md, « The company »): TestUSDC on NEAR testnet, 0.1 to 2 a payment,
 * 10 a day, listed recipients only. Ruggy's two suppliers are accounts of ours: the list starts empty.
 */
export const RUGGY_LAW: ForkedLaw = {
  id: "ruggy",
  banner: "Ruggy's law, pre-filled. Change anything.",
  rules: [
    "Pays in TestUSDC on NEAR testnet",
    "Between 0.1 and 2 USDC a payment",
    "At most 10 USDC a day",
    "Listed recipients only",
  ],
  hint: "The recipients list starts empty: add your own suppliers in the role.",
  block: { kind: "near-transfer", token: "TestUSDC", receivers: [], amount: "10", periodDays: 1, maxPerTransfer: "2", minPerTransfer: "0.1" },
};

const LAWS: Record<string, ForkedLaw> = { ruggy: RUGGY_LAW };

export function forkedLawOf(id: string | null | undefined): ForkedLaw | null {
  return (id && Object.prototype.hasOwnProperty.call(LAWS, id) ? LAWS[id] : null) ?? null;
}

/** The URL parameter the role builder reads, next to `job`. */
export const LAW_PARAM = "law";

const PENDING_KEY = "mandateos.forked-law";
const companyKey = (organizationId: string) => `mandateos.forked-law.${organizationId}`;
/** A law picked on /rob and never used (an existing member sent to /overview) does not wait forever. */
const PENDING_TTL_MS = 24 * 3_600_000;

/** From the URL: keep it for the company about to be created. */
export function rememberPendingLaw(law: ForkedLaw, now = Date.now()): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ id: law.id, at: now }));
  } catch {
    // A convenience only: the role builder still opens, empty.
  }
}

function pendingLaw(now = Date.now()): ForkedLaw | null {
  try {
    const saved = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null") as { id?: string; at?: number } | null;
    if (!saved || typeof saved.at !== "number" || now - saved.at > PENDING_TTL_MS) return null;
    return forkedLawOf(saved.id);
  } catch {
    return null;
  }
}

/**
 * The law of this company: its own, or the pending one, which then becomes its own.
 * Called once the company exists (after the « Company » step).
 */
export function lawForCompany(organizationId: string, now = Date.now()): ForkedLaw | null {
  try {
    const own = forkedLawOf(localStorage.getItem(companyKey(organizationId)));
    if (own) return own;
    const pending = pendingLaw(now);
    if (!pending) return null;
    localStorage.setItem(companyKey(organizationId), pending.id);
    localStorage.removeItem(PENDING_KEY);
    return pending;
  } catch {
    return null;
  }
}

/** The role builder link, with the law when there is one. */
export function roleBuilderPath(role: string, jobId: string | null, law: ForkedLaw | null): string {
  return `/roles?new=1&role=${encodeURIComponent(role)}${jobId ? `&job=${jobId}` : ""}${law ? `&${LAW_PARAM}=${law.id}` : ""}`;
}
