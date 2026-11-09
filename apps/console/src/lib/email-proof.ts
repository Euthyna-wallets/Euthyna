/**
 * ZK Email in the console: the person drops the .eml of an email they sent themself; the
 * browser proves, with the Noir circuit, that their mail provider signed it. The email never
 * leaves the browser: only the zero-knowledge proof does, and the recovery contract on NEAR
 * verifies it (contracts/email-recovery).
 */
import {
  circuitInputs, dkimKeyHash, emlFromBytes, modulusFromDkimRecord, PROOF_TARGET, publicInputBytes, readPublicInputs, senderDkim,
} from "@euthyna/sdk/email-proof";

import { API_BASE } from "../api.js";
import { viewContract } from "../wallets.js";
import { HOSTED_G1_POINTS, openProver } from "./crs.js";

export { newSalt, recoverySubject } from "@euthyna/sdk/email-proof";

/**
 * Public or disposable inboxes: anyone who knows the address can open them. Accepted on testnet so the
 * flow can be tried with a throwaway inbox; never registered on mainnet (docs/recovery.md).
 */
export const PUBLIC_INBOX_DOMAINS = ["yopmail.com"];

/** The recovery contract: it verifies the proofs, keeps the enrollments, runs the waiting period. */
export const RECOVERY_CONTRACT_ID: string = import.meta.env.VITE_EUTHYNA_RECOVERY_ID ?? "euthyna-recovery-v5.testnet";

export type ChainEnrollment = { account_id: string; salt: string; identity: string; domain: string; enrolled_at_ns: string };
/** What a contract call takes: the proof and its public inputs, base64. */
export type ContractProof = { proof: string; public_inputs: string };

type Circuit = { bytecode: string; abi: unknown };
let circuit: Promise<Circuit> | null = null;
const loadCircuit = () => (circuit ??= fetch("/circuits/email_recovery.json").then((response) => {
  if (!response.ok) throw new Error("Could not load the email circuit");
  return response.json() as Promise<Circuit>;
}));

const threads = () => (globalThis.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 1, 8) : 1);

/**
 * Why a pasted email has no DKIM-Signature header. Headers there but no signature: the provider
 * did not sign it, which is what Gmail does with an email sent to yourself. No headers at all: only
 * the body was copied.
 */
export function unsignedText(source: string): string {
  if (/^(from|received|delivered-to|message-id):/im.test(source)) {
    return "This email has no DKIM signature: its provider did not sign it. Gmail does not sign an email you send to yourself. Send it to another address you can open, then copy its source from the mailbox that received it.";
  }
  return "Paste the whole original message, headers included (it starts with lines like \"Delivered-To:\" or \"Received:\")";
}

/** The email from a downloaded .eml file, or from its source pasted as text ("Show original" → copy). */
export async function emailSource(input: File | string): Promise<string> {
  if (typeof input === "string") {
    if (input.length > 2_000_000) throw new Error("This is too long for an email");
    if (!/^dkim-signature:/im.test(input)) throw new Error(unsignedText(input));
    return input;
  }
  if (input.size > 2_000_000) throw new Error("This file is too large for an email");
  const eml = emlFromBytes(new Uint8Array(await input.arrayBuffer()));
  if (!/^dkim-signature:/im.test(eml)) throw new Error(unsignedText(eml));
  return eml;
}

/** A seat's enrollment, read from the contract (null when the founder never enrolled). */
export function enrollmentOf(daoAccountId: string, accountId: string): Promise<ChainEnrollment | null> {
  return viewContract<ChainEnrollment | null>(RECOVERY_CONTRACT_ID, "enrollment", { dao_id: daoAccountId, account_id: accountId });
}

/**
 * Prove that the mailbox sent this email, with `salt` in the address hash. Only DKIM keys the
 * contract knows for the domain are tried. `onStep` reports progress.
 */
export async function proveEmailFile(input: File | string, salt: string, onStep: (step: string) => void): Promise<{ proof: ContractProof; domain: string; subject: string }> {
  const eml = await emailSource(input);
  const dkim = senderDkim(eml);
  onStep(`Fetching ${dkim.domain}'s DKIM key…`);
  const response = await fetch(`${API_BASE}/v1/recovery/dkim-key?${new URLSearchParams({ domain: dkim.domain, selector: dkim.selector })}`, { credentials: "include" });
  const { records } = (await response.json()) as { records?: string[] };
  if (!records?.length) throw new Error(`${dkim.domain} publishes no DKIM key for selector ${dkim.selector}`);
  const known = new Set(await viewContract<string[]>(RECOVERY_CONTRACT_ID, "dkim_keys", { domain: dkim.domain }));
  const moduli: bigint[] = [];
  for (const record of records) {
    try {
      const modulus = modulusFromDkimRecord(record);
      if (known.has(await dkimKeyHash(modulus))) moduli.push(modulus);
    } catch { /* not a 2048-bit RSA key */ }
  }
  if (!moduli.length) {
    throw new Error(`The recovery contract does not accept ${dkim.domain}'s DKIM key yet (selector ${dkim.selector}). Use another mailbox (Gmail, Outlook, iCloud…) or ask Euthyna to add it.`);
  }
  const [{ Noir }, { UltraHonkBackend }, compiled] = await Promise.all([import("@noir-lang/noir_js"), import("@aztec/bb.js"), loadCircuit()]);
  onStep("Checking the email's signature…");
  let witness: Uint8Array | null = null;
  for (const modulus of moduli) {
    try {
      const { inputs } = circuitInputs(eml, modulus, salt);
      witness = (await new Noir(compiled as never).execute(inputs as never)).witness;
      break;
    } catch (error) {
      if (moduli.length === 1) throw new Error(`This email does not verify: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  if (!witness) throw new Error("No DKIM key of the domain verifies this email");
  onStep("Proving in your browser…");
  // 2^18 gates: the hosted 2^19 points, as bb.js would take from Aztec.
  const api = await openProver(threads(), HOSTED_G1_POINTS);
  try {
    const result = await new UltraHonkBackend(compiled.bytecode, api).generateProof(witness, { verifierTarget: PROOF_TARGET });
    const stated = readPublicInputs(result.publicInputs);
    return { proof: { proof: base64(result.proof), public_inputs: base64(publicInputBytes(result.publicInputs)) }, domain: stated.domain, subject: stated.subject };
  } finally {
    await api.destroy();
  }
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
