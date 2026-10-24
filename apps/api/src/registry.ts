import { readFile } from "node:fs/promises";
import { bytesToHex, decodeFunctionData, getAddress, type Address } from "viem";
import { z } from "zod";
import { bytesToAddress } from "./evm.js";
import type { Registry, VaultOperation } from "./types.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const registrySchema = z.object({
  clientId: z.string().min(1),
  registryVersion: z.number().int().nonnegative(),
  network: z.literal("base-sepolia"),
  chainId: z.literal(84532),
  token: z.object({ symbol: z.literal("USDC"), address: address.nullable(), decimals: z.literal(6) }),
  roles: z.record(
    z.string(),
    z.object({
      maximumPayment: z.string().regex(/^\d+$/),
      vendors: z.array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          addresses: z.array(
            z.object({ address, maximumPayment: z.string().regex(/^\d+$/).optional() }),
          ),
        }),
      ),
    }),
  ),
});
const erc20TransferAbi = [{
  type: "function",
  name: "transfer",
  stateMutability: "nonpayable",
  inputs: [
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ type: "bool" }],
}] as const;


export async function loadRegistry(path: string): Promise<Registry> {
  return registrySchema.parse(JSON.parse(await readFile(path, "utf8"))) as Registry;
}

export type RegistryDecision =
  | { decision: "approve"; vendorId: string; vendorName: string }
  | { decision: "escalate"; reasons: string[] };

export function evaluateExactRules(registry: Registry, operation: VaultOperation): RegistryDecision {
  const reasons: string[] = [];
  if (operation.client_id !== registry.clientId) reasons.push("client_id mismatch");
  if (operation.registry_version !== registry.registryVersion) reasons.push("registry_version mismatch");
  if (operation.transaction.chain_id !== registry.chainId) reasons.push("chain_id mismatch");
  const token = bytesToAddress(operation.request.target);
  if (!registry.token.address) {
    reasons.push("token not deployed");
  } else if (token !== getAddress(registry.token.address)) {
    reasons.push("token mismatch");
  }
  const role = registry.roles[operation.role];
  if (!role) return { decision: "escalate", reasons: [...reasons, "role not registered"] };
  let recipient: Address;
  let amount: bigint;
  try {
    const decoded = decodeFunctionData({
      abi: erc20TransferAbi,
      data: bytesToHex(Uint8Array.from(operation.request.calldata)),
    });
    if (decoded.functionName !== "transfer") throw new Error("not transfer");
    [recipient, amount] = decoded.args;
  } catch {
    return { decision: "escalate", reasons: [...reasons, "unrecognized payment calldata"] };
  }
  const match = role.vendors
    .flatMap((vendor) => vendor.addresses.map((entry) => ({ vendor, entry })))
    .find(({ entry }) => getAddress(entry.address) === recipient);
  if (!match) return { decision: "escalate", reasons: [...reasons, "recipient not registered"] };
  const maximum = BigInt(match.entry.maximumPayment ?? role.maximumPayment);
  if (amount > maximum) reasons.push("amount exceeds exact vendor limit");
  if (reasons.length > 0) return { decision: "escalate", reasons };
  return { decision: "approve", vendorId: match.vendor.id, vendorName: match.vendor.name };
}

export function normalizeRegistryAddress(value: string): Address {
  return getAddress(value);
}
