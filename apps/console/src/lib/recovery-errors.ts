/**
 * The recovery contract (`contracts/email-recovery`) refuses with a code; a wallet or RPC error wraps it in JSON.
 * This finds the code and says what it means and what to do.
 */
const MEANINGS: Record<string, string> = {
  ERR_DIFFERENT_MAILBOX: "This email comes from another mailbox than the one the founder enrolled. Send it from the enrolled mailbox.",
  ERR_WRONG_SALT: "This proof was made for another enrollment. Reload the page and prove the email again.",
  ERR_WRONG_SUBJECT: "The email's subject is not the one shown. Send a new email with exactly that subject.",
  ERR_NOT_ENROLLED: "This founder never enrolled a mailbox for this DAO.",
  ERR_SAME_ACCOUNT: "Sign in with a new account: the lost account cannot ask for its own seat.",
  ERR_RECOVERY_OPEN: "A request for this seat is already open. Wait for it to be voted, cancelled or to expire.",
  ERR_NO_RECOVERY: "There is no open request for this seat.",
  ERR_RECOVERY_COOLDOWN: "The founder cancelled a request for this seat recently. A new one can be filed once the waiting period after that cancel is over.",
  ERR_DKIM_KEY_UNKNOWN: "The contract does not know this provider's signing key yet. Try a Gmail, Outlook or iCloud mailbox.",
  ERR_PROOF_INVALID: "The proof did not verify on chain. Prove the email again.",
  ERR_PROOF_SIZE: "The proof is malformed. Prove the email again.",
  ERR_PUBLIC_INPUTS: "The proof is malformed. Prove the email again.",
};

export function recoveryErrorText(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const code = raw.match(/ERR_[A-Z_]+/)?.[0];
  const meaning = code ? MEANINGS[code] : undefined;
  return meaning ? `${meaning} (${code})` : raw;
}
