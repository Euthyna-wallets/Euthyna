// Compile the sealed-order circuit (nargo 1.0.0-beta.26) and publish what the rest needs:
//   packages/sdk/circuits/sealed_order.json          the circuit, for the SDK prover (watcher, MCP,
//                                                    prove.mjs); sealing only hashes, in the browser
//   contracts/sealed-orders/src/vk.bin               its verification key, built into the contract
// The key is for zero-knowledge proofs with a Keccak transcript (bb's "evm" target), the format the
// on-chain verifier reads, as for circuits/email-recovery.
// Usage: node circuits/sealed-order/build.mjs   (needs nargo 1.0.0-beta.26 in $NARGO or ~/.nargo/bin)
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const nargo = process.env.NARGO ?? join(homedir(), ".nargo/bin/nargo");
execFileSync(nargo, ["compile"], { cwd: here, stdio: "inherit" });
const circuitPath = join(here, "target/sealed_order.json");
const circuit = JSON.parse(readFileSync(circuitPath, "utf8"));
for (const dir of ["packages/sdk/circuits"]) {
  mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(circuitPath, join(root, dir, "sealed_order.json"));
}

const { Barretenberg, UltraHonkBackend } = await import(join(root, "apps/api/node_modules/@aztec/bb.js/dest/node/index.js"));
const api = await Barretenberg.new({ threads: 1 });
const vk = await new UltraHonkBackend(circuit.bytecode, api).getVerificationKey({ verifierTarget: "evm" });
await api.destroy();
mkdirSync(join(root, "contracts/sealed-orders/src"), { recursive: true });
writeFileSync(join(root, "contracts/sealed-orders/src/vk.bin"), vk);
const bytecodeHash = createHash("sha256").update(circuit.bytecode).digest("hex");
console.log(`circuit ${bytecodeHash}, vk ${vk.length} bytes`);
process.exit(0);
