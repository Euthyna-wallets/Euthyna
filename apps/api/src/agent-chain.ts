import { bytesToHex, getAddress, type Address } from "viem";

function decodeEvmAddress(value: unknown): Address | null {
  if (value === null || value === undefined) return null;
  const bytes = Array.isArray(value)
    ? Uint8Array.from(value.map((item) => {
        if (typeof item !== "number") throw new Error("EVM address contains a non-number byte");
        return item;
      }))
    : typeof value === "string"
      ? Uint8Array.from(Buffer.from(value, "base64"))
      : null;
  if (!bytes) return null;
  if (bytes.length !== 20) throw new Error("EVM address must contain 20 bytes");
  return getAddress(bytesToHex(bytes));
}

export function onChainWalletEvmAddress(state: unknown): Address | null {
  if (!state || typeof state !== "object" || !("address" in state)) return null;
  return decodeEvmAddress(state.address);
}

/** Transitional reader for stored pre-OmniRoles deployments until task 2 removes them. */
export function onChainAgentEvmAddress(state: unknown): Address | null {
  if (!state || typeof state !== "object" || !("evm_address" in state)) return null;
  return decodeEvmAddress(state.evm_address);
}
