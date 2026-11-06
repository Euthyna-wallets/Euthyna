/**
 * Commitments and fill proofs for sealed orders (circuits/sealed-order), with the same bb.js and
 * noir_js as the email recovery. The circuit file is written by circuits/sealed-order/build.mjs.
 */
import { readFileSync } from "node:fs";

import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { Noir } from "@noir-lang/noir_js";
import { commitmentInputs, vaultTag, type SealedOrder } from "@euthyna/sdk";

type Circuit = { bytecode: string } & Record<string, unknown>;
let circuit: Circuit | null = null;
function loadCircuit(): Circuit {
  circuit ??= JSON.parse(readFileSync(new URL("./sealed_order.json", import.meta.url), "utf8")) as Circuit;
  return circuit;
}

const hex32 = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const bytes32 = (value: bigint) => Uint8Array.from(Buffer.from(hex32(value).slice(2), "hex"));

export type Fill = { amountIn: bigint; filledBefore: bigint; rate: bigint; now: number };
export type FillProof = { proof: string; publicInputs: string[]; commitment: string };

export async function commitmentOf(order: SealedOrder, api?: Barretenberg): Promise<string> {
  const own = api ?? (await Barretenberg.new({ threads: 1 }));
  try {
    const { hash } = await own.poseidon2Hash({ inputs: commitmentInputs(order).map(bytes32) });
    return `0x${Buffer.from(hash).toString("hex")}`;
  } finally {
    if (!api) await own.destroy();
  }
}

/**
 * Proves a fill. Throws (from the circuit) when the fill breaks a hidden term: a rate below the limit
 * ("rate below the limit"), more than the cap ("over the cap") or after the deadline ("expired").
 */
export async function proveFill(order: SealedOrder, fill: Fill): Promise<FillProof> {
  const compiled = loadCircuit();
  const api = await Barretenberg.new({ threads: 1 });
  try {
    const commitment = await commitmentOf(order, api);
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
    const { witness } = await new Noir(compiled as never).execute(inputs);
    const backend = new UltraHonkBackend(compiled.bytecode, api);
    const proof = await backend.generateProof(witness, { verifierTarget: "evm" });
    if (!(await backend.verifyProof(proof, { verifierTarget: "evm" }))) throw new Error("the fill proof does not verify");
    return { proof: Buffer.from(proof.proof).toString("base64"), publicInputs: proof.publicInputs, commitment };
  } finally {
    await api.destroy();
  }
}
