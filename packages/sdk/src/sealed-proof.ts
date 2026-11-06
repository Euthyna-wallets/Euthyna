/**
 * Fill proofs for sealed orders, in Node or in a browser: the caller passes the compiled circuit
 * (packages/sdk/circuits/sealed_order.json). No Node API here; `sealed-prover` wraps it for Node.
 */
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { Noir } from "@noir-lang/noir_js";

import { commitmentInputs, vaultTag, type SealedOrder } from "./sealed-orders.js";

export type SealedCircuit = { bytecode: string } & Record<string, unknown>;
export type Fill = { amountIn: bigint; filledBefore: bigint; rate: bigint; now: number };
export type FillProof = { proof: string; publicInputs: string[]; commitment: string };

const hex32 = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const bytes32 = (value: bigint) => {
  const out = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0; i -= 1) { out[i] = Number(rest & 0xffn); rest >>= 8n; }
  return out;
};
const toHex = (bytes: Uint8Array) => `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function sealedCommitment(order: SealedOrder, api?: Barretenberg): Promise<string> {
  const own = api ?? (await Barretenberg.new({ threads: 1 }));
  try {
    const { hash } = await own.poseidon2Hash({ inputs: commitmentInputs(order).map(bytes32) });
    return toHex(hash);
  } finally {
    if (!api) await own.destroy();
  }
}

/**
 * Proves a fill. Throws (from the circuit) when the fill breaks a hidden term: a rate below the limit,
 * more than the cap, or after the deadline.
 */
export async function proveSealedFill(circuit: SealedCircuit, order: SealedOrder, fill: Fill): Promise<FillProof> {
  const api = await Barretenberg.new({ threads: 1 });
  try {
    const commitment = await sealedCommitment(order, api);
    const inputs = {
      commitment,
      vault_tag: hex32(vaultTag(order.vaultId)),
      chain_id: String(order.chainId),
      token_in: hex32(BigInt(order.tokenIn)),
      token_out: hex32(BigInt(order.tokenOut)),
      fee: String(order.fee),
      amount_in: fill.amountIn.toString(),
      filled_before: fill.filledBefore.toString(),
      rate: fill.rate.toString(),
      now: String(fill.now),
      limit_rate: order.limitRate.toString(),
      cap: order.cap.toString(),
      expiry: String(order.expiry),
      salt: hex32(order.salt),
    };
    const { witness } = await new Noir(circuit as never).execute(inputs);
    const backend = new UltraHonkBackend(circuit.bytecode, api);
    const proof = await backend.generateProof(witness, { verifierTarget: "evm" });
    if (!(await backend.verifyProof(proof, { verifierTarget: "evm" }))) throw new Error("the fill proof does not verify");
    return { proof: toBase64(proof.proof), publicInputs: proof.publicInputs, commitment };
  } finally {
    await api.destroy();
  }
}
