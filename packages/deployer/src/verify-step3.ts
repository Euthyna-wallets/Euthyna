import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createPublicClient, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const manifest = JSON.parse(
  await readFile(resolve(REPO_ROOT, "deployments/base-sepolia.json"), "utf8"),
) as {
  contracts: { safe: Address; roles: Address; delay: Address };
  transactions: { zodiacDirectAttackRejected: Hex };
  observed: {
    safeOwners: Address[];
    safeThreshold: number;
    safeModules: Address[];
    delayModules: Address[];
    delayCooldownSeconds: number;
    delayExpirationSeconds: number;
    researcherAllowanceBaseUnits: string;
  };
};
const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const moduleAbi = parseAbi([
  "function getModulesPaginated(address,uint256) view returns (address[],address)",
]);
const safeAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);
const delayAbi = parseAbi([
  "function txCooldown() view returns (uint256)",
  "function txExpiration() view returns (uint256)",
]);
const rolesAbi = parseAbi([
  "function allowances(bytes32) view returns (uint128 refill,uint128 maxRefill,uint128 period,uint128 balance,uint64 timestamp)",
]);
const sentinel = getAddress("0x0000000000000000000000000000000000000001");
const [owners, threshold, safeModulePage, delayModulePage, cooldown, expiration, allowance, attackReceipt] =
  await Promise.all([
    client.readContract({ address: manifest.contracts.safe, abi: safeAbi, functionName: "getOwners" }),
    client.readContract({ address: manifest.contracts.safe, abi: safeAbi, functionName: "getThreshold" }),
    client.readContract({ address: manifest.contracts.safe, abi: moduleAbi, functionName: "getModulesPaginated", args: [sentinel, 10n] }),
    client.readContract({ address: manifest.contracts.delay, abi: moduleAbi, functionName: "getModulesPaginated", args: [sentinel, 10n] }),
    client.readContract({ address: manifest.contracts.delay, abi: delayAbi, functionName: "txCooldown" }),
    client.readContract({ address: manifest.contracts.delay, abi: delayAbi, functionName: "txExpiration" }),
    client.readContract({ address: manifest.contracts.roles, abi: rolesAbi, functionName: "allowances", args: ["0x726573656172636865722d757364630000000000000000000000000000000000"] }),
    client.getTransactionReceipt({ hash: manifest.transactions.zodiacDirectAttackRejected }),
  ]);
const normalize = (values: readonly Address[]) => values.map((value) => value.toLowerCase()).sort();
if (JSON.stringify(normalize(owners)) !== JSON.stringify(normalize(manifest.observed.safeOwners))) {
  throw new Error("Safe owners differ from manifest");
}
if (threshold !== BigInt(manifest.observed.safeThreshold)) throw new Error("Safe threshold mismatch");
if (JSON.stringify(normalize(safeModulePage[0])) !== JSON.stringify(normalize(manifest.observed.safeModules))) {
  throw new Error("Safe modules differ from manifest");
}
if (JSON.stringify(normalize(delayModulePage[0])) !== JSON.stringify(normalize(manifest.observed.delayModules))) {
  throw new Error("Delay modules differ from manifest");
}
if (cooldown !== BigInt(manifest.observed.delayCooldownSeconds)) throw new Error("Delay cooldown mismatch");
if (expiration !== BigInt(manifest.observed.delayExpirationSeconds)) throw new Error("Delay expiration mismatch");
if (allowance[3] !== BigInt(manifest.observed.researcherAllowanceBaseUnits)) {
  throw new Error("Roles allowance mismatch");
}
if (attackReceipt.status !== "reverted") throw new Error("Direct signed Zodiac attack did not revert");
console.log(JSON.stringify({
  owners,
  threshold: threshold.toString(),
  safeModules: safeModulePage[0],
  delayModules: delayModulePage[0],
  cooldown: cooldown.toString(),
  expiration: expiration.toString(),
  allowance: allowance[3].toString(),
  zodiacDirectAttackStatus: attackReceipt.status,
}, null, 2));
