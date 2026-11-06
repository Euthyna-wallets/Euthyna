/**
 * Commitments and fill proofs for sealed orders in Node: loads the circuit written by
 * circuits/sealed-order/build.mjs and uses the browser-safe core in sealed-proof.ts.
 */
import { readFileSync } from "node:fs";

import type { SealedOrder } from "./sealed-orders.js";
import { proveSealedFill, sealedCommitment, type Fill, type FillProof, type SealedCircuit } from "./sealed-proof.js";

export type { Fill, FillProof } from "./sealed-proof.js";

let circuit: SealedCircuit | null = null;
function loadCircuit(): SealedCircuit {
  circuit ??= JSON.parse(readFileSync(new URL("../circuits/sealed_order.json", import.meta.url), "utf8")) as SealedCircuit;
  return circuit;
}

export const commitmentOf = (order: SealedOrder): Promise<string> => sealedCommitment(order);

export function proveFill(order: SealedOrder, fill: Fill): Promise<FillProof> {
  return proveSealedFill(loadCircuit(), order, fill);
}
