/**
 * ZK Email in the console: the person drops the .eml of an email they sent themself; the
 * browser proves, with the Noir circuit, that their mail provider signed it. The email
 * never leaves the browser, only the proof does.
 */
import { circuitInputs, EMAIL_RECOVERY_VK_BASE64, emlFromBytes, modulusFromDkimRecord, readPublicInputs, senderDkim, type EmailEvidence } from "@mandateos/sdk/email-proof";

import { API_BASE } from "../api.js";

export { recoverySubject, type EmailEvidence } from "@mandateos/sdk/email-proof";

type Circuit = { bytecode: string; abi: unknown };
let circuit: Promise<Circuit> | null = null;
const loadCircuit = () => (circuit ??= fetch("/circuits/email_recovery.json").then((response) => {
  if (!response.ok) throw new Error("Could not load the email circuit");
  return response.json() as Promise<Circuit>;
}));

const threads = () => (globalThis.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 1, 8) : 1);

/** The email from a downloaded .eml file, or from its source pasted as text ("Show original" → copy). */
export async function emailSource(input: File | string): Promise<string> {
  if (typeof input === "string") {
    if (input.length > 2_000_000) throw new Error("This is too long for an email");
    if (!/^dkim-signature:/im.test(input)) throw new Error("Paste the whole original message, headers included (it starts with lines like \"Delivered-To:\" or \"Received:\")");
    return input;
  }
  if (input.size > 2_000_000) throw new Error("This file is too large for an email");
  return emlFromBytes(new Uint8Array(await input.arrayBuffer()));
}

/** Prove that the mailbox sent this email. Takes about a minute; `onStep` reports progress. */
export async function proveEmailFile(input: File | string, onStep: (step: string) => void): Promise<{ evidence: EmailEvidence; domain: string; subject: string }> {
  const eml = await emailSource(input);
  const dkim = senderDkim(eml);
  onStep(`Fetching ${dkim.domain}'s DKIM key…`);
  const response = await fetch(`${API_BASE}/v1/recovery/dkim-key?${new URLSearchParams({ domain: dkim.domain, selector: dkim.selector })}`, { credentials: "include" });
  const { records } = (await response.json()) as { records?: string[] };
  if (!records?.length) throw new Error(`${dkim.domain} publishes no DKIM key for selector ${dkim.selector}`);
  const [{ Noir }, { UltraHonkBackend }, compiled] = await Promise.all([import("@noir-lang/noir_js"), import("@aztec/bb.js"), loadCircuit()]);
  onStep("Checking the email's signature…");
  let witness: Uint8Array | null = null;
  for (const record of records) {
    try {
      const { inputs } = circuitInputs(eml, modulusFromDkimRecord(record));
      witness = (await new Noir(compiled as never).execute(inputs as never)).witness;
      break;
    } catch (error) {
      if (records.length === 1) throw new Error(`This email does not verify: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  if (!witness) throw new Error("No DKIM key of the domain verifies this email");
  onStep("Proving in your browser (about a minute)…");
  const backend = new UltraHonkBackend(compiled.bytecode, { threads: threads() });
  const proof = await backend.generateProof(witness);
  const evidence = { proof: base64(proof.proof), publicInputs: proof.publicInputs, selector: dkim.selector };
  const stated = readPublicInputs(evidence.publicInputs);
  return { evidence, domain: stated.domain, subject: stated.subject };
}

/** Verify a proof in this browser, with the circuit's key: no trust in Euthyna's server. */
export async function checkEmailProof(evidence: EmailEvidence) {
  const { BarretenbergVerifier } = await import("@aztec/bb.js");
  const vk = Uint8Array.from(atob(EMAIL_RECOVERY_VK_BASE64), (char) => char.charCodeAt(0));
  const proof = Uint8Array.from(atob(evidence.proof), (char) => char.charCodeAt(0));
  const valid = await new BarretenbergVerifier({ threads: 1 }).verifyUltraHonkProof({ proof, publicInputs: evidence.publicInputs }, vk);
  return { valid, ...readPublicInputs(evidence.publicInputs) };
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
