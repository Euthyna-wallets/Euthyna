import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getSafeL2SingletonDeployment } from "@safe-global/safe-deployments";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
  zeroAddress,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { z } from "zod";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TEMPORARY_GOV = getAddress("0x7e4FBed7A7B20A5671095DFBEb6B8A034934EAa6");
const MINIMUM_GOV_GAS = 5_000_000_000_000_000n;
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => getAddress(value));
const env = z.object({
  BASE_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia.base.org"),
  BASE_DEPLOYER_PRIVATE_KEY: privateKey,
  COUNCIL_PRIVATE_KEY_1: privateKey,
  COUNCIL_PRIVATE_KEY_2: privateKey,
  COUNCIL_PRIVATE_KEY_3: privateKey,
  GOV_RELAY_ADDRESS: address,
}).parse(process.env);

interface Manifest {
  contracts: { safe: Address; delay: Address; [key: string]: Address };
  policy: Record<string, unknown>;
  transactions: Record<string, Hex>;
  observed?: Record<string, unknown>;
  [key: string]: unknown;
}

interface SafeTransaction {
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
}

function safeTransactionArgs(transaction: SafeTransaction) {
  return [
    transaction.to,
    transaction.value,
    transaction.data,
    transaction.operation,
    transaction.safeTxGas,
    transaction.baseGas,
    transaction.gasPrice,
    transaction.gasToken,
    transaction.refundReceiver,
    transaction.nonce,
  ] as const;
}

async function signSafeHash(accounts: PrivateKeyAccount[], hash: Hex): Promise<Hex> {
  const signatures = await Promise.all(
    accounts.slice(0, 2).map(async (account) => ({
      owner: account.address,
      signature: await account.sign({ hash }),
    })),
  );
  return concatHex(
    signatures
      .sort((left, right) => left.owner.toLowerCase().localeCompare(right.owner.toLowerCase()))
      .map(({ signature }) => signature),
  );
}

const manifestPath = resolve(REPO_ROOT, "deployments/base-sepolia.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
const deployer = privateKeyToAccount(env.BASE_DEPLOYER_PRIVATE_KEY);
const council = [
  privateKeyToAccount(env.COUNCIL_PRIVATE_KEY_1),
  privateKeyToAccount(env.COUNCIL_PRIVATE_KEY_2),
  privateKeyToAccount(env.COUNCIL_PRIVATE_KEY_3),
].sort((left, right) => left.address.toLowerCase().localeCompare(right.address.toLowerCase()));
const client = createPublicClient({ chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
const wallet = createWalletClient({ account: deployer, chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
const safeDeployment = getSafeL2SingletonDeployment({ network: "84532", version: "1.4.1" });
if (!safeDeployment) throw new Error("SafeL2 1.4.1 deployment not found");
const safeAbi = safeDeployment.abi as Abi;
const delayAbi = [
  { type: "function", name: "enableModule", stateMutability: "nonpayable", inputs: [{ name: "module", type: "address" }], outputs: [] },
  { type: "function", name: "disableModule", stateMutability: "nonpayable", inputs: [{ name: "prevModule", type: "address" }, { name: "module", type: "address" }], outputs: [] },
  { type: "function", name: "setTxCooldown", stateMutability: "nonpayable", inputs: [{ name: "cooldown", type: "uint256" }], outputs: [] },
] as const;
const calls = [
  {
    name: "enableRealGovOnDelay",
    data: encodeFunctionData({ abi: delayAbi, functionName: "enableModule", args: [env.GOV_RELAY_ADDRESS] }),
  },
  {
    name: "disableTemporaryGovOnDelay",
    data: encodeFunctionData({ abi: delayAbi, functionName: "disableModule", args: [env.GOV_RELAY_ADDRESS, TEMPORARY_GOV] }),
  },
  {
    name: "setSepoliaCooldown300",
    data: encodeFunctionData({ abi: delayAbi, functionName: "setTxCooldown", args: [300n] }),
  },
];
let safeNonce = await client.readContract({
  address: manifest.contracts.safe,
  abi: safeAbi,
  functionName: "nonce",
}) as bigint;
for (const call of calls) {
  const transaction: SafeTransaction = {
    to: manifest.contracts.delay,
    value: 0n,
    data: call.data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce: safeNonce,
  };
  const safeTxHash = await client.readContract({
    address: manifest.contracts.safe,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: safeTransactionArgs(transaction),
  }) as Hex;
  const signatures = await signSafeHash(council, safeTxHash);
  const hash = await wallet.writeContract({
    address: manifest.contracts.safe,
    abi: safeAbi,
    functionName: "execTransaction",
    args: [...safeTransactionArgs(transaction).slice(0, 9), signatures],
    gas: 500_000n,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${call.name} failed`);
  manifest.transactions[call.name] = hash;
  safeNonce += 1n;
}
const balance = await client.getBalance({ address: env.GOV_RELAY_ADDRESS });
if (balance < MINIMUM_GOV_GAS) {
  const hash = await wallet.sendTransaction({
    to: env.GOV_RELAY_ADDRESS,
    value: MINIMUM_GOV_GAS - balance,
  });
  await client.waitForTransactionReceipt({ hash });
  manifest.transactions.fundGovernanceRelayGas = hash;
}
manifest.policy.govAddress = env.GOV_RELAY_ADDRESS;
manifest.policy.cooldownSeconds = 300;
manifest.observed = {
  ...(manifest.observed ?? {}),
  delayModules: [env.GOV_RELAY_ADDRESS],
  delayCooldownSeconds: 300,
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ govAddress: env.GOV_RELAY_ADDRESS, transactions: manifest.transactions }, null, 2));
