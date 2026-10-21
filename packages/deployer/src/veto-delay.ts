import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getSafeL2SingletonDeployment } from "@safe-global/safe-deployments";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Abi,
  type Address,
  type Hex,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { z } from "zod";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex);
const env = z.object({
  BASE_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia.base.org"),
  BASE_DEPLOYER_PRIVATE_KEY: privateKey,
  COUNCIL_PRIVATE_KEY_1: privateKey,
  COUNCIL_PRIVATE_KEY_2: privateKey,
  COUNCIL_PRIVATE_KEY_3: privateKey,
  DELAY_NEW_NONCE: z.coerce.bigint().nonnegative(),
}).parse(process.env);
const path = resolve(REPO_ROOT, "deployments/base-sepolia.json");
const manifest = JSON.parse(await readFile(path, "utf8")) as {
  contracts: { safe: Address; delay: Address };
  transactions: Record<string, Hex>;
  [key: string]: unknown;
};
const deployer = privateKeyToAccount(env.BASE_DEPLOYER_PRIVATE_KEY);
const owners = [
  privateKeyToAccount(env.COUNCIL_PRIVATE_KEY_1),
  privateKeyToAccount(env.COUNCIL_PRIVATE_KEY_2),
  privateKeyToAccount(env.COUNCIL_PRIVATE_KEY_3),
].sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
const client = createPublicClient({ chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
const wallet = createWalletClient({ account: deployer, chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
const deployment = getSafeL2SingletonDeployment({ network: "84532", version: "1.4.1" });
if (!deployment) throw new Error("SafeL2 deployment missing");
const abi = deployment.abi as Abi;
const data = encodeFunctionData({
  abi: [{ type: "function", name: "setTxNonce", stateMutability: "nonpayable", inputs: [{ name: "nonce", type: "uint256" }], outputs: [] }],
  functionName: "setTxNonce",
  args: [env.DELAY_NEW_NONCE],
});
const nonce = await client.readContract({ address: manifest.contracts.safe, abi, functionName: "nonce" }) as bigint;
const args = [
  manifest.contracts.delay,
  0n,
  data,
  0,
  0n,
  0n,
  0n,
  zeroAddress,
  zeroAddress,
  nonce,
] as const;
const safeTxHash = await client.readContract({
  address: manifest.contracts.safe,
  abi,
  functionName: "getTransactionHash",
  args,
}) as Hex;
const signatures = await Promise.all(
  owners.slice(0, 2).map(async (owner) => ({
    owner: owner.address,
    signature: await owner.sign({ hash: safeTxHash }),
  })),
);
const packed = concatHex(
  signatures
    .sort((a, b) => a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()))
    .map(({ signature }) => signature),
);
const hash = await wallet.writeContract({
  address: manifest.contracts.safe,
  abi,
  functionName: "execTransaction",
  args: [...args.slice(0, 9), packed],
  gas: 500_000n,
});
const receipt = await client.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error("Delay veto failed");
manifest.transactions[`vetoDelayNonce${env.DELAY_NEW_NONCE}`] = hash;
await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ hash, newNonce: env.DELAY_NEW_NONCE.toString() }, null, 2));
