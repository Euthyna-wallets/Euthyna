/**
 * The first jobs an AI company can hire an agent for. Each one opens the role
 * builder with the matching block: the members still choose the budget and
 * vote on it, and the vault enforces it.
 */
export type JobId = "payments" | "revenue" | "treasury";

export type Job = {
  id: JobId;
  title: string;
  agentName: string;
  role: string;
  pitch: string;
  /** What the role allows, in one line. */
  allows: string;
  needsShares?: boolean;
};

export const JOBS: Job[] = [
  {
    id: "payments",
    title: "Pay suppliers",
    agentName: "Payments agent",
    role: "payments",
    pitch: "Pays registered suppliers in USDC, invoice by invoice.",
    allows: "USDC transfers to registered suppliers, within a budget",
  },
  {
    id: "revenue",
    title: "Share revenue",
    agentName: "Revenue agent",
    role: "revenue",
    pitch: "Sends the ETH the company earns to the shareholders who vote.",
    allows: "ETH to the company's shares contract only, through the Omni Bridge, within a budget",
    needsShares: true,
  },
  {
    id: "treasury",
    title: "Manage the treasury",
    agentName: "Treasury agent",
    role: "treasury",
    pitch: "Swaps company tokens on Uniswap; what it buys always returns to the company wallet.",
    allows: "Uniswap V3 swaps of USDC, within a budget",
  },
];

export function jobOf(id: string | null | undefined): Job | null {
  return JOBS.find((job) => job.id === id) ?? null;
}

const chosenKey = (organizationId: string) => `mandateos.first-job.${organizationId}`;

export function rememberJob(organizationId: string, job: JobId): void {
  try {
    localStorage.setItem(chosenKey(organizationId), job);
  } catch {
    // Remembering the choice is a convenience only.
  }
}

export function rememberedJob(organizationId: string): Job | null {
  try {
    return jobOf(localStorage.getItem(chosenKey(organizationId)));
  } catch {
    return null;
  }
}
