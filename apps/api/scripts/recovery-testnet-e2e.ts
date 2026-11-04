/**
 * Seat recovery end to end on NEAR testnet, against the deployed recovery contract: the same
 * proving code as the browser (noir_js + bb.js, zero-knowledge), real transactions.
 *
 *   KEYS=<dir> DAO=<dao>.sputnikv2.testnet pnpm --filter @mandateos/api exec tsx scripts/recovery-testnet-e2e.ts <step>
 *
 * <dir> holds <account>.json key files ({ account_id, secret_key }) for the founders and the new
 * account, and test-mail-domain.json (a test mail domain whose DKIM key the contract's keeper
 * registered). Steps: enroll | request | cancel | status | vote.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { newSalt, publicInputBytes, recoverySubject } from "@mandateos/sdk/email-proof";

import { proveEmail, signedEmail } from "../src/recovery/test-mail.js";

const require = createRequire(import.meta.url);
const { connect, KeyPair, keyStores } = require("near-api-js") as typeof import("near-api-js");

const CONTRACT = process.env.RECOVERY_CONTRACT_ID ?? "euthyna-recovery.testnet";
const KEYS = process.env.KEYS ?? ".";
const DAO = process.env.DAO ?? "";
const LOST = process.env.LOST ?? "eut-rec-alice.testnet";
const NEW = process.env.NEW ?? "eut-rec-bob.testnet";
const VOTERS = (process.env.VOTERS ?? "eut-rec-carol.testnet,eut-rec-dave.testnet").split(",");
const MAILBOX = process.env.MAILBOX ?? "Alice.Founder@mail.euthyna-test.dev";
const DEPOSIT = 50_000_000_000_000_000_000_000n;
const GAS = 300_000_000_000_000n;

const store = new keyStores.InMemoryKeyStore();
const near = await connect({ networkId: "testnet", nodeUrl: process.env.RPC ?? "https://test.rpc.fastnear.com", keyStore: store });
async function account(id: string) {
  const key = JSON.parse(readFileSync(join(KEYS, `${id}.json`), "utf8")) as { secret_key: string };
  await store.setKey("testnet", id, KeyPair.fromString(key.secret_key as never));
  return near.account(id);
}
const view = async <T>(method: string, args: Record<string, unknown>) => (await near.account(CONTRACT)).viewFunction({ contractId: CONTRACT, methodName: method, args }) as Promise<T>;
const mail = JSON.parse(readFileSync(join(KEYS, "test-mail-domain.json"), "utf8")) as { domain: string; selector: string; privateKey: string; record: string; name: string };
type Outcome = { transaction: { hash: string }; status: { SuccessValue?: string; Failure?: unknown }; receipts_outcome: Array<{ outcome: { gas_burnt: number } }>; transaction_outcome: { outcome: { gas_burnt: number } } };
const burnt = (out: Outcome) => ((out.receipts_outcome.reduce((sum, item) => sum + item.outcome.gas_burnt, 0) + out.transaction_outcome.outcome.gas_burnt) / 1e12).toFixed(1);

async function prove(subject: string, salt: string) {
  const started = Date.now();
  const proof = await proveEmail(await signedEmail(mail, MAILBOX, subject), mail.record, salt);
  console.log(`proved "${subject}" in ${Date.now() - started} ms`);
  return { proof: proof.proof, public_inputs: Buffer.from(publicInputBytes(proof.publicInputs)).toString("base64") };
}

async function call(signer: string, method: string, args: Record<string, unknown>, deposit = 0n) {
  const out = await (await account(signer)).functionCall({ contractId: CONTRACT, methodName: method, args, gas: GAS, attachedDeposit: deposit }) as unknown as Outcome;
  console.log(`${method} by ${signer}: tx ${out.transaction.hash}, ${burnt(out)} Tgas`);
  return out;
}

const step = process.argv[2];
if (!DAO) throw new Error("DAO=<dao account> is required");
if (step === "enroll") {
  await call(LOST, "enroll", { dao_id: DAO, ...(await prove(recoverySubject("enroll", LOST), newSalt())) }, DEPOSIT);
  console.log(await view("enrollment", { dao_id: DAO, account_id: LOST }));
} else if (step === "request") {
  const enrollment = await view<{ salt: string } | null>("enrollment", { dao_id: DAO, account_id: LOST });
  if (!enrollment) throw new Error(`${LOST} is not enrolled`);
  // Another mailbox first: refused by the contract.
  const other = await proveEmail(await signedEmail(mail, "mallory@mail.euthyna-test.dev", recoverySubject("recovery", NEW)), mail.record, `0x${enrollment.salt}`);
  try {
    await call(NEW, "request", { dao_id: DAO, lost_account_id: LOST, proof: other.proof, public_inputs: Buffer.from(publicInputBytes(other.publicInputs)).toString("base64") }, DEPOSIT);
    throw new Error("another mailbox was accepted");
  } catch (error) {
    console.log(`another mailbox: refused (${String(error).match(/ERR_[A-Z_]+/)?.[0] ?? String(error).slice(0, 120)})`);
  }
  await call(NEW, "request", { dao_id: DAO, lost_account_id: LOST, ...(await prove(recoverySubject("recovery", NEW), `0x${enrollment.salt}`)) }, DEPOSIT);
  console.log(await view("recovery", { dao_id: DAO, lost_account_id: LOST }));
} else if (step === "cancel") {
  await call(LOST, "cancel", { dao_id: DAO });
  console.log(await view("recoveries_of", { dao_id: DAO }));
} else if (step === "status") {
  console.log(JSON.stringify({ enrollments: await view("enrollments_of", { dao_id: DAO }), recoveries: await view("recoveries_of", { dao_id: DAO }) }, null, 2));
} else if (step === "vote") {
  // What the console drafts once the contract says the recovery is ready: replace the lost
  // account by the new one in the DAO's council; the other founders approve.
  const open = await view<{ ready: boolean; new_account_id: string } | null>("recovery", { dao_id: DAO, lost_account_id: LOST });
  if (!open?.ready) throw new Error("the recovery is not ready: the lost account can still cancel");
  const dao = await near.account(DAO);
  const policy = await dao.viewFunction({ contractId: DAO, methodName: "get_policy", args: {} }) as { proposal_bond: string };
  const proposer = await account(VOTERS[0]!);
  for (const kind of [{ AddMemberToRole: { member_id: open.new_account_id, role: "council" } }, { RemoveMemberFromRole: { member_id: LOST, role: "council" } }]) {
    const out = await proposer.functionCall({ contractId: DAO, methodName: "add_proposal", args: { proposal: { description: `Seat recovery: ${LOST} → ${open.new_account_id}, proved on ${CONTRACT}`, kind } }, gas: 150_000_000_000_000n, attachedDeposit: BigInt(policy.proposal_bond) }) as unknown as Outcome;
    const id = Number(Buffer.from(out.status.SuccessValue ?? "", "base64").toString());
    console.log(`proposal #${id} (${Object.keys(kind)[0]}): tx ${out.transaction.hash}`);
    for (const voter of VOTERS) {
      const vote = await (await account(voter)).functionCall({ contractId: DAO, methodName: "act_proposal", args: { id, action: "VoteApprove", proposal: kind }, gas: 200_000_000_000_000n }) as unknown as Outcome;
      console.log(`  approved by ${voter}: tx ${vote.transaction.hash}`);
    }
  }
  const after = await dao.viewFunction({ contractId: DAO, methodName: "get_policy", args: {} }) as { roles: Array<{ name: string; kind: { Group?: string[] } }> };
  console.log("council now:", after.roles.find((role) => role.name === "council")?.kind.Group);
} else {
  throw new Error("step: enroll | request | cancel | status | vote");
}
process.exit(0);
