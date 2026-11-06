// Seal or prove a sealed order from the command line (the contract tests use it; so can a member).
//   echo '{"mode":"commit", ...order}' | node circuits/sealed-order/prove.mjs
//   echo '{"mode":"prove", ...order, "amountIn":…, "filledBefore":…, "rate":…, "now":…}' | node circuits/sealed-order/prove.mjs
// An order: vaultId, chainId, tokenIn, tokenOut (0x…), fee, limitRate, cap, expiry (unix seconds), salt
// (decimal or 0x…). Prints JSON: commitment, vaultTag, and for "prove" the proof (base64) and the
// public inputs. Uses the published circuit (packages/sdk/circuits) and the bb.js and noir_js installed for apps/api.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const modules = join(root, "apps/api/node_modules");
const { Barretenberg, UltraHonkBackend } = await import(join(modules, "@aztec/bb.js/dest/node/index.js"));
const { Noir } = await import(join(modules, "@noir-lang/noir_js/lib/index.mjs"));

const order = JSON.parse(readFileSync(0, "utf8"));
const big = (value) => BigInt(value);
const hex32 = (value) => "0x" + big(value).toString(16).padStart(64, "0");
const bytes32 = (value) => Buffer.from(hex32(value).slice(2), "hex");

/** sha256 of the vault account with its first byte cleared, as the contract computes it. */
export function vaultTag(vaultId) {
  const digest = createHash("sha256").update(vaultId).digest();
  digest[0] = 0;
  return big("0x" + digest.toString("hex"));
}

const api = await Barretenberg.new({ threads: 1 });
const tag = vaultTag(order.vaultId);
const fields = [tag, order.chainId, order.tokenIn, order.tokenOut, order.fee, order.limitRate, order.cap, order.expiry, order.salt].map(big);
const commitment = big("0x" + Buffer.from((await api.poseidon2Hash({ inputs: fields.map(bytes32) })).hash).toString("hex"));
const out = { commitment: hex32(commitment), vaultTag: hex32(tag) };

if (order.mode === "prove") {
  // The compiled circuit build.mjs publishes (target/ is not committed).
  const circuit = JSON.parse(readFileSync(join(root, "packages/sdk/circuits/sealed_order.json"), "utf8"));
  const inputs = {
    commitment: hex32(commitment),
    vault_tag: hex32(tag),
    chain_id: String(order.chainId),
    token_in: hex32(order.tokenIn),
    token_out: hex32(order.tokenOut),
    fee: String(order.fee),
    amount_in: String(order.amountIn),
    filled_before: String(order.filledBefore),
    rate: String(order.rate),
    now: String(order.now),
    limit_rate: String(order.limitRate),
    cap: String(order.cap),
    expiry: String(order.expiry),
    salt: hex32(order.salt),
  };
  const { witness } = await new Noir(circuit).execute(inputs);
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  const proof = await backend.generateProof(witness, { verifierTarget: "evm" });
  const ok = await backend.verifyProof(proof, { verifierTarget: "evm" });
  if (!ok) throw new Error("the proof does not verify");
  out.proof = Buffer.from(proof.proof).toString("base64");
  out.publicInputs = proof.publicInputs;
}
await api.destroy();
process.stdout.write(JSON.stringify(out) + "\n");
process.exit(0);
