/** Sealed orders in the browser: the Poseidon2 commitment (bb.js), so the hidden terms never leave it. */
import { commitmentInputs, type SealedOrder } from "@euthyna/sdk/sealed-orders";

const bytes32 = (value: bigint) => {
  const out = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0; i -= 1) { out[i] = Number(rest & 0xffn); rest >>= 8n; }
  return out;
};

export async function commitmentOf(order: SealedOrder): Promise<`0x${string}`> {
  const { Barretenberg } = await import("@aztec/bb.js");
  // A Poseidon2 hash needs no CRS: nothing to download.
  const api = await Barretenberg.new({ threads: 1, skipSrsInit: true });
  try {
    const { hash } = await api.poseidon2Hash({ inputs: commitmentInputs(order).map(bytes32) });
    return `0x${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  } finally {
    await api.destroy();
  }
}

/** Saves the order file: the only copy of the hidden terms. */
export function downloadOrderFile(name: string, content: unknown) {
  const blob = new Blob([JSON.stringify(content, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}
