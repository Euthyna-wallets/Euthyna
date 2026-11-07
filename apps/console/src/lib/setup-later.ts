/**
 * "Skip for now" on the company setup, once the wallet exists: the founders hire agents and vote
 * roles later from Agents and Rules, and the console stops reminding them. Per company, per browser.
 */
const key = (organizationId: string) => `euthyna.setup-later.${organizationId}`;

export function setupLater(organizationId: string | null | undefined): boolean {
  if (!organizationId) return false;
  try {
    return localStorage.getItem(key(organizationId)) === "1";
  } catch {
    return false;
  }
}

export function rememberSetupLater(organizationId: string): void {
  try {
    localStorage.setItem(key(organizationId), "1");
  } catch {
    // A convenience only: the reminder comes back.
  }
}
