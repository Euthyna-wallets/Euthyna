/**
 * Private bank beneficiaries: what a member's browser builds when the members vote an IBAN.
 *
 * Nothing that names the IBAN or its holder goes on chain. The vote carries:
 * - a commitment, sha256("euthyna-bank-beneficiary-v1" 0 vault 0 IBAN 0 holder 0 type 0 salt),
 *   salted so an IBAN cannot be found by trying candidates;
 * - an envelope only the bank signer's enclave can open (X25519 to its box key, AES-256-GCM, the
 *   vault's account as associated data), which it checks against the commitment before any payout;
 * - an envelope for the members' reading keys (the scheme of the sealed orders), so members read it.
 * Must match bank-signer/src/main.rs (`commitment_of`, `open`) byte for byte.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, concatBytes, hexToBytes, sha256, stringToBytes, type Hex } from "viem";

import { canonicalIban, validIban } from "./roles.js";
import { decryptForReader, encryptForReaders } from "./sealed-orders.js";

export type HolderType = "Business" | "Individual";
export type PrivateBeneficiary = { vault: string; iban: string; name: string; holder_type: HolderType; salt: string };
export type BeneficiaryVote = { commitment: string; sealedForSigner: string; sealedForMembers: string };

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const random = (size: number) => globalThis.crypto.getRandomValues(new Uint8Array(size));

export function beneficiaryCommitment(vault: string, iban: string, name: string, holderType: string, salt: string): string {
  const parts = ["euthyna-bank-beneficiary-v1", vault, canonicalIban(iban), name, holderType, salt].map((part) => stringToBytes(part));
  const joined = parts.flatMap((part, index) => (index === 0 ? [part] : [new Uint8Array([0]), part]));
  return sha256(concatBytes(joined)).slice(2);
}

/** Seals for the enclave's X25519 box key (hex, 32 bytes), bound to the vault. `entropy` is for tests. */
export async function sealForSigner(value: PrivateBeneficiary, boxKeyHex: string, entropy?: { ephemeral: Uint8Array; iv: Uint8Array }): Promise<string> {
  const signerKey = hexToBytes(`0x${boxKeyHex.replace(/^0x/, "")}` as Hex);
  if (signerKey.length !== 32) throw new Error("the bank signer's box key is 32 bytes");
  const ephemeral = entropy?.ephemeral ?? random(32);
  const iv = entropy?.iv ?? random(12);
  const epk = x25519.getPublicKey(ephemeral);
  const key = hexToBytes(sha256(concatBytes([x25519.getSharedSecret(ephemeral, signerKey), epk, signerKey])));
  const aesKey = await globalThis.crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: stringToBytes(value.vault) as BufferSource }, aesKey, plaintext));
  return btoa(JSON.stringify({ v: 1, epk: b64(epk), iv: b64(iv), ct: b64(ct) }));
}

/**
 * Everything a member's browser sends for the vote: the commitment and the two envelopes. The IBAN
 * and the holder stay in the browser and in the envelopes.
 */
export async function beneficiaryVote(input: {
  vault: string;
  iban: string;
  name: string;
  holderType: HolderType;
  boxKeyHex: string;
  readers: Array<{ account: string; publicKey: string }>;
}): Promise<BeneficiaryVote & { salt: string }> {
  if (!validIban(input.iban)) throw new Error("This IBAN does not pass the checksum");
  const name = input.name.trim();
  if (!name || name.length > 255 || !/^[ -~]+$/.test(name)) throw new Error("The account holder name must be 1 to 255 printable ASCII characters");
  const salt = bytesToHex(random(32)).slice(2);
  const value: PrivateBeneficiary = { vault: input.vault, iban: canonicalIban(input.iban), name, holder_type: input.holderType, salt };
  return {
    salt,
    commitment: beneficiaryCommitment(input.vault, value.iban, name, input.holderType, salt),
    sealedForSigner: await sealForSigner(value, input.boxKeyHex),
    sealedForMembers: await encryptForReaders(value, input.readers),
  };
}

/** A member reads a beneficiary, and checks it is the one committed on chain. */
export async function readBeneficiary(sealedForMembers: string, commitment: string, account: string, privateKey: Uint8Array): Promise<PrivateBeneficiary | null> {
  const value = (await decryptForReader(sealedForMembers, account, privateKey)) as PrivateBeneficiary | null;
  if (!value) return null;
  return beneficiaryCommitment(value.vault, value.iban, value.name, value.holder_type, value.salt) === commitment.toLowerCase() ? value : null;
}

// ---------------------------------------------------------------------------
// v2: any payout rail of the partner (payroll and remittances)
// ---------------------------------------------------------------------------

/** Compact JSON with sorted keys, as serde_json writes a Value (bank-signer `commitment_v2`). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function beneficiaryCommitmentV2(vault: string, channelId: string, form: Record<string, unknown>, salt: string): string {
  const parts = ["euthyna-bank-beneficiary-v2", vault, channelId, canonicalJson(form), salt].map((part) => stringToBytes(part));
  const joined = parts.flatMap((part, index) => (index === 0 ? [part] : [new Uint8Array([0]), part]));
  return sha256(concatBytes(joined)).slice(2);
}

export type RailId = "sepa" | "pix" | "ach" | "uk";
export type Rail = {
  id: RailId;
  country: string;
  currency: string;
  /** The partner's payment method type, to pick the channel (`GET /channels/sell`). */
  method: "BankSepa" | "IdentifierPix" | "BankAch" | "BankLocal";
  title: string;
  fields: Array<{ key: string; label: string; placeholder?: string; options?: Array<[string, string]> }>;
};

/** The rails Euthyna fills a form for. Every value stays in the sealed envelopes. */
export const RAILS: Rail[] = [
  { id: "sepa", country: "FR", currency: "EUR", method: "BankSepa", title: "Euro bank account (SEPA)", fields: [
    { key: "name", label: "Account holder" }, { key: "holderType", label: "Holder type", options: [["Business", "Business"], ["Individual", "Individual"]] },
    { key: "iban", label: "IBAN", placeholder: "FR76 …" },
  ] },
  { id: "pix", country: "BR", currency: "BRL", method: "IdentifierPix", title: "Brazil (Pix)", fields: [
    { key: "firstName", label: "First name" }, { key: "lastName", label: "Last name" },
    { key: "pixType", label: "Pix key type", options: [["Email", "Email"], ["PhoneNumber", "Phone number"], ["TaxID", "CPF / CNPJ"], ["UUID", "Random key"]] },
    { key: "pixKey", label: "Pix key" },
  ] },
  { id: "ach", country: "US", currency: "USD", method: "BankAch", title: "United States (ACH)", fields: [
    { key: "name", label: "Account holder" }, { key: "holderType", label: "Holder type", options: [["Business", "Business"], ["Individual", "Individual"]] },
    { key: "routing", label: "Routing number" }, { key: "account", label: "Account number" },
    { key: "accountType", label: "Account type", options: [["Checking", "Checking"], ["Savings", "Savings"]] },
    { key: "line1", label: "Address" }, { key: "city", label: "City" }, { key: "state", label: "State", placeholder: "NY" }, { key: "postalCode", label: "ZIP" },
  ] },
  { id: "uk", country: "GB", currency: "GBP", method: "BankLocal", title: "United Kingdom (Faster Payments)", fields: [
    { key: "name", label: "Account holder" }, { key: "holderType", label: "Holder type", options: [["Business", "Business"], ["Individual", "Individual"]] },
    { key: "sortCode", label: "Sort code", placeholder: "040004" }, { key: "account", label: "Account number" }, { key: "bankName", label: "Bank name" },
    { key: "purpose", label: "Purpose", options: [["SALARY", "Salary"], ["SUPPLIER_PAYMENT", "Supplier payment"], ["FAMILY_SUPPORT", "Family support"]] },
  ] },
];

function holderName(type: string, name: string) {
  if (type === "Business") return { AccountHolderType: "Business", Name: name.trim() };
  const [first, ...rest] = name.trim().split(/\s+/);
  return { AccountHolderType: "Individual", Name: { FirstName: first ?? "", LastName: rest.join(" ") || "-" } };
}

/**
 * The partner's payout form for a rail (its `GET /channels/{id}/form` schema), from what a member
 * typed. `Reference` is left empty when the rail takes one: the enclave puts the payout's reference
 * there. Returns the form and the name members see.
 */
export function railForm(rail: RailId, values: Record<string, string>): { form: Record<string, unknown>; display: string } {
  const v = (key: string) => (values[key] ?? "").trim();
  switch (rail) {
    case "sepa":
      if (!validIban(v("iban"))) throw new Error("This IBAN does not pass the checksum");
      return { form: { AccountHolderName: holderName(v("holderType") || "Business", v("name")), BankDetails: { AccountNumber: canonicalIban(v("iban")) }, Reference: "" }, display: v("name") };
    case "pix":
      if (!v("firstName") || !v("pixKey")) throw new Error("A Pix payout needs a name and a Pix key");
      return { form: { BeneficiaryName: { FirstName: v("firstName"), LastName: v("lastName") }, IdentifierDetails: { IdentifierType: v("pixType") || "Email", Identifier: v("pixKey") } }, display: `${v("firstName")} ${v("lastName")}`.trim() };
    case "ach":
      if (!/^\d{9}$/.test(v("routing")) || !/^\d{4,17}$/.test(v("account"))) throw new Error("An ACH payout needs a 9-digit routing number and an account number");
      return {
        form: {
          AccountHolderName: holderName(v("holderType") || "Business", v("name")),
          BankDetails: { AccountNumber: v("account"), RoutingNumber: v("routing"), AccountType: v("accountType") || "Checking" },
          AccountHolderAddress: { line1: v("line1"), city: v("city"), state: v("state"), postalCode: v("postalCode"), countryCode: "US" },
          Reference: "",
        },
        display: v("name"),
      };
    case "uk":
      if (!/^\d{6}$/.test(v("sortCode").replace(/-/g, "")) || !/^\d{8}$/.test(v("account"))) throw new Error("A UK payout needs a 6-digit sort code and an 8-digit account number");
      return {
        form: { AccountHolderName: holderName(v("holderType") || "Business", v("name")), BankDetails: { AccountNumber: v("account"), SortCode: v("sortCode").replace(/-/g, ""), BankName: v("bankName") }, PaymentPurpose: v("purpose") || "SUPPLIER_PAYMENT" },
        display: v("name"),
      };
  }
}

export type PrivateBeneficiaryV2 = { vault: string; channel_id: string; form: Record<string, unknown>; salt: string };
export type MembersCopy = PrivateBeneficiaryV2 & { display: { name: string; rail: RailId; country: string; currency: string } };

/** Seals for the enclave (same envelope as v1). `entropy` is for tests. */
export async function sealV2ForSigner(value: PrivateBeneficiaryV2, boxKeyHex: string, entropy?: { ephemeral: Uint8Array; iv: Uint8Array }): Promise<string> {
  return sealForSigner(value as unknown as PrivateBeneficiary, boxKeyHex, entropy);
}

/** The vote for a beneficiary on any rail: commitment and envelopes; nothing readable on chain. */
export async function payeeVote(input: {
  vault: string; rail: RailId; channelId: string; values: Record<string, string>; boxKeyHex: string;
  readers: Array<{ account: string; publicKey: string }>;
}): Promise<BeneficiaryVote & { salt: string; display: string }> {
  const rail = RAILS.find((item) => item.id === input.rail);
  if (!rail) throw new Error("unknown rail");
  if (!/^[0-9a-f-]{36}$/i.test(input.channelId)) throw new Error("unknown payout channel");
  const { form, display } = railForm(input.rail, input.values);
  if (!display) throw new Error("The beneficiary needs a name");
  const salt = bytesToHex(random(32)).slice(2);
  const signerCopy: PrivateBeneficiaryV2 = { vault: input.vault, channel_id: input.channelId, form, salt };
  const membersCopy: MembersCopy = { ...signerCopy, display: { name: display, rail: rail.id, country: rail.country, currency: rail.currency } };
  return {
    salt,
    display,
    commitment: beneficiaryCommitmentV2(input.vault, input.channelId, form, salt),
    sealedForSigner: await sealV2ForSigner(signerCopy, input.boxKeyHex),
    sealedForMembers: await encryptForReaders(membersCopy, input.readers),
  };
}

/** What a member reads of a beneficiary, either version, checked against the commitment. */
export type ReadPayee = { name: string; rail: RailId; country: string; currency: string; account: string };
export async function readPayee(sealedForMembers: string, commitment: string, account: string, privateKey: Uint8Array): Promise<ReadPayee | null> {
  const value = (await decryptForReader(sealedForMembers, account, privateKey)) as (PrivateBeneficiary & Partial<MembersCopy>) | null;
  if (!value) return null;
  if (value.form && value.channel_id && value.display) {
    if (beneficiaryCommitmentV2(value.vault, value.channel_id, value.form, value.salt) !== commitment.toLowerCase()) return null;
    const details = canonicalJson(value.form);
    const accountText = (/"AccountNumber":"([^"]+)"/.exec(details)?.[1] ?? /"Identifier":"([^"]+)"/.exec(details)?.[1] ?? "").replace(/^(.{4}).*(.{4})$/, "$1 … $2");
    return { ...value.display, account: accountText };
  }
  if (beneficiaryCommitment(value.vault, value.iban, value.name, value.holder_type, value.salt) !== commitment.toLowerCase()) return null;
  return { name: value.name, rail: "sepa", country: value.iban.slice(0, 2), currency: "EUR", account: value.iban };
}
