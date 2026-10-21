import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { encodeDeployProxy, predictProxyAddress } from "@gnosis-guild/zodiac-core";
import {
  getMultiSendDeployment,
  getProxyFactoryDeployment,
  getSafeL2SingletonDeployment,
  type SingletonDeployment,
} from "@safe-global/safe-deployments";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  stringToHex,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { rolesAbi } from "zodiac-roles-sdk";
import { z } from "zod";
import { compileResearcherUsdcPermission } from "./roles-policy.js";

const CHAIN_ID = 84532;
const SAFE_VERSION = "1.4.1";
const ROLES_VERSION = "2.1.1";
const DELAY_VERSION = "1.1.1";
const SAFE_THRESHOLD = 2n;
const ROLES_MASTERCOPY = getAddress("0xf2964ce6161ce0e75964fe7927ce114cb0b283d5");
const DELAY_MASTERCOPY = getAddress("0x824175b945838d127c1ca83cbce11d8e44f6df01");
const MODULE_PROXY_FACTORY = getAddress("0x000000000000aDdB49795b0f9bA5BC298cDda236");
const COOLDOWN = 300n;
const EXPIRATION = 604_800n;
const UAT_ALLOWANCE = 5_000_000n;
const MINIMUM_AGENT_GAS = 5_000_000_000_000_000n;
const MINIMUM_DEPLOYER_GAS = 10_000_000_000_000_000n;
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => getAddress(value));
const envSchema = z.object({
  BASE_DEPLOY_CONFIRM: z.literal("DEPLOY_ACME_BASE_SEPOLIA"),
  BASE_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia.base.org"),
  BASE_DEPLOYER_PRIVATE_KEY: privateKey,
  COUNCIL_PRIVATE_KEY_1: privateKey,
  COUNCIL_PRIVATE_KEY_2: privateKey,
  COUNCIL_PRIVATE_KEY_3: privateKey,
  BASE_ALLOWED_RECIPIENT: address,
  GOV_ADDRESS: address,
  RESEARCHER_ADDRESS: address,
  RESUME_TEST_USDC_ADDRESS: address.optional(),
  RESUME_SAFE_ADDRESS: address.optional(),
  RESUME_ROLES_ADDRESS: address.optional(),
  RESUME_DELAY_ADDRESS: address.optional(),
  RESUME_TEST_USDC_TX_HASH: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex).optional(),
  RESUME_SAFE_TX_HASH: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex).optional(),
  RESUME_ROLES_TX_HASH: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex).optional(),
  RESUME_DELAY_TX_HASH: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex).optional(),
  RESUME_CONFIG_STEP: z.coerce.number().int().min(0).max(7).default(0),
  RESUME_ENABLE_ROLES_TX_HASH: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex).optional(),
  RESUME_ENABLE_DELAY_TX_HASH: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex).optional(),
  RESUME_ASSIGN_RESEARCHER_TX_HASH: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex).optional(),
  RESUME_SCOPE_TARGET_TX_HASH: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex).optional(),
});

interface SafeTransaction {
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
}

interface Manifest {
  observedAt: string;
  chainId: 84532;
  network: "base-sepolia";
  versions: Record<string, string>;
  contracts: Record<string, Address>;
  policy: Record<string, string | number | Address>;
  transactions: Record<string, Hex>;
  codeHashes: Record<string, Hex>;
}

interface ForgeArtifact {
  abi: Abi;
  bytecode: { object: Hex };
}

function requireDeployment(value: SingletonDeployment | undefined, name: string): SingletonDeployment {
  if (!value) throw new Error(`${name} ${SAFE_VERSION} is not registered on Base`);
  return value;
}

function deploymentAddress(deployment: SingletonDeployment): Address {
  return getAddress(deployment.networkAddresses[String(CHAIN_ID)] ?? deployment.defaultAddress);
}

function encodeMultiSend(transactions: Array<{ to: Address; value?: bigint; data: Hex }>): Hex {
  const packed = transactions.map((transaction) => {
    const byteLength = BigInt((transaction.data.length - 2) / 2);
    return concatHex([
      toHex(0, { size: 1 }),
      transaction.to,
      toHex(transaction.value ?? 0n, { size: 32 }),
      toHex(byteLength, { size: 32 }),
      transaction.data,
    ]);
  });
  return concatHex(packed);
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

function signatureFromAccount(account: PrivateKeyAccount, hash: Hex): Promise<Hex> {
  return account.sign({ hash });
}

async function assertContractCode(
  entries: Record<string, Address>,
): Promise<Record<string, Hex>> {
  const hashes: Record<string, Hex> = {};
  for (const [name, contractAddress] of Object.entries(entries)) {
    const bytecode = await publicClient.getBytecode({ address: contractAddress });
    if (!bytecode || bytecode === "0x") throw new Error(`${name} has no code at ${contractAddress}`);
    hashes[name] = keccak256(bytecode);
  }
  return hashes;
}

const env = envSchema.parse(process.env);
const deployer = privateKeyToAccount(env.BASE_DEPLOYER_PRIVATE_KEY);
const councilAccounts = [
  privateKeyToAccount(env.COUNCIL_PRIVATE_KEY_1),
  privateKeyToAccount(env.COUNCIL_PRIVATE_KEY_2),
  privateKeyToAccount(env.COUNCIL_PRIVATE_KEY_3),
].sort((left, right) => left.address.toLowerCase().localeCompare(right.address.toLowerCase()));
const uniqueOwners = new Set(councilAccounts.map((account) => account.address.toLowerCase()));
if (uniqueOwners.size !== 3) throw new Error("the three council private keys must resolve to distinct owners");

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
const walletClient = createWalletClient({ account: deployer, chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
if (await publicClient.getChainId() !== CHAIN_ID) throw new Error("BASE_SEPOLIA_RPC_URL is not Base Sepolia");
const deployerBalance = await publicClient.getBalance({ address: deployer.address });
if (deployerBalance < MINIMUM_DEPLOYER_GAS) {
  throw new Error(
    `fund ${deployer.address} with at least ${MINIMUM_DEPLOYER_GAS} wei of Base Sepolia ETH`,
  );
}

const safeSingletonDeployment = requireDeployment(
  getSafeL2SingletonDeployment({ network: String(CHAIN_ID), version: SAFE_VERSION }),
  "SafeL2",
);
const safeFactoryDeployment = requireDeployment(
  getProxyFactoryDeployment({ network: String(CHAIN_ID), version: SAFE_VERSION }),
  "SafeProxyFactory",
);
const multiSendDeployment = requireDeployment(
  getMultiSendDeployment({ network: String(CHAIN_ID), version: SAFE_VERSION }),
  "MultiSend",
);
const safeSingleton = deploymentAddress(safeSingletonDeployment);
const safeFactory = deploymentAddress(safeFactoryDeployment);
const multiSend = deploymentAddress(multiSendDeployment);

const canonicalCodeHashes = await assertContractCode({
  safeSingleton,
  safeFactory,
  multiSend,
  rolesMastercopy: ROLES_MASTERCOPY,
  delayMastercopy: DELAY_MASTERCOPY,
  moduleProxyFactory: MODULE_PROXY_FACTORY,
});

const resumeValues = [
  env.RESUME_TEST_USDC_ADDRESS,
  env.RESUME_SAFE_ADDRESS,
  env.RESUME_ROLES_ADDRESS,
  env.RESUME_DELAY_ADDRESS,
  env.RESUME_TEST_USDC_TX_HASH,
  env.RESUME_SAFE_TX_HASH,
  env.RESUME_ROLES_TX_HASH,
  env.RESUME_DELAY_TX_HASH,
];
const resumeCount = resumeValues.filter((value) => value !== undefined).length;
if (resumeCount !== 0 && resumeCount !== resumeValues.length) {
  throw new Error("all RESUME_* addresses and transaction hashes must be set together");
}

let testUsdc: Address;
let safe: Address;
let roles: Address;
let delay: Address;
let deployTestUsdcHash: Hex;
let safeDeployHash: Hex;
let rolesDeployHash: Hex;
let delayDeployHash: Hex;

if (resumeCount === resumeValues.length) {
  testUsdc = env.RESUME_TEST_USDC_ADDRESS!;
  safe = env.RESUME_SAFE_ADDRESS!;
  roles = env.RESUME_ROLES_ADDRESS!;
  delay = env.RESUME_DELAY_ADDRESS!;
  deployTestUsdcHash = env.RESUME_TEST_USDC_TX_HASH!;
  safeDeployHash = env.RESUME_SAFE_TX_HASH!;
  rolesDeployHash = env.RESUME_ROLES_TX_HASH!;
  delayDeployHash = env.RESUME_DELAY_TX_HASH!;
} else {
  const testUsdcArtifact = JSON.parse(
    await readFile(
      resolve(REPO_ROOT, "packages/deployer/out/TestUSDC.sol/TestUSDC.json"),
      "utf8",
    ),
  ) as ForgeArtifact;
  deployTestUsdcHash = await walletClient.deployContract({
    abi: testUsdcArtifact.abi,
    bytecode: testUsdcArtifact.bytecode.object,
  });
  const testUsdcReceipt = await publicClient.waitForTransactionReceipt({
    hash: deployTestUsdcHash,
  });
  if (!testUsdcReceipt.contractAddress) {
    throw new Error("TestUSDC deployment receipt has no contract address");
  }
  testUsdc = getAddress(testUsdcReceipt.contractAddress);

  const setupData = encodeFunctionData({
    abi: safeSingletonDeployment.abi as Abi,
    functionName: "setup",
    args: [
      councilAccounts.map((account) => account.address),
      SAFE_THRESHOLD,
      zeroAddress,
      "0x",
      zeroAddress,
      zeroAddress,
      0n,
      zeroAddress,
    ],
  });
  const safeSaltNonce = BigInt(keccak256(stringToHex("mandateos:acme:base-sepolia:safe:v1")));
  safeDeployHash = await walletClient.writeContract({
    address: safeFactory,
    abi: safeFactoryDeployment.abi as Abi,
    functionName: "createProxyWithNonce",
    args: [safeSingleton, setupData, safeSaltNonce],
  });
  const safeDeployReceipt = await publicClient.waitForTransactionReceipt({ hash: safeDeployHash });
  const proxyEvents = parseEventLogs({
    abi: safeFactoryDeployment.abi as Abi,
    logs: safeDeployReceipt.logs,
    eventName: "ProxyCreation",
  });
  const safeProxy = (proxyEvents[0]?.args as { proxy?: Address } | undefined)?.proxy;
  if (!safeProxy) throw new Error("SafeProxyFactory did not emit ProxyCreation");
  safe = getAddress(safeProxy);

  const rolesSaltNonce = BigInt(keccak256(stringToHex(`mandateos:${safe}:roles:${ROLES_VERSION}`)));
  const rolesSetup = { types: ["address", "address", "address"], values: [safe, safe, safe] };
  roles = getAddress(
    predictProxyAddress({
      factory: MODULE_PROXY_FACTORY,
      mastercopy: ROLES_MASTERCOPY,
      setupArgs: rolesSetup,
      saltNonce: rolesSaltNonce,
    }),
  );
  const rolesDeployTx = encodeDeployProxy({
    factory: MODULE_PROXY_FACTORY,
    mastercopy: ROLES_MASTERCOPY,
    setupArgs: rolesSetup,
    saltNonce: rolesSaltNonce,
  });
  rolesDeployHash = await walletClient.sendTransaction({
    to: getAddress(String(rolesDeployTx.to)),
    data: rolesDeployTx.data as Hex,
  });
  await publicClient.waitForTransactionReceipt({ hash: rolesDeployHash });

  const delaySaltNonce = BigInt(keccak256(stringToHex(`mandateos:${safe}:delay:${DELAY_VERSION}`)));
  const delaySetup = {
    types: ["address", "address", "address", "uint256", "uint256"],
    values: [safe, safe, safe, COOLDOWN, EXPIRATION],
  };
  delay = getAddress(
    predictProxyAddress({
      factory: MODULE_PROXY_FACTORY,
      mastercopy: DELAY_MASTERCOPY,
      setupArgs: delaySetup,
      saltNonce: delaySaltNonce,
    }),
  );
  const delayDeployTx = encodeDeployProxy({
    factory: MODULE_PROXY_FACTORY,
    mastercopy: DELAY_MASTERCOPY,
    setupArgs: delaySetup,
    saltNonce: delaySaltNonce,
  });
  delayDeployHash = await walletClient.sendTransaction({
    to: getAddress(String(delayDeployTx.to)),
    data: delayDeployTx.data as Hex,
  });
  await publicClient.waitForTransactionReceipt({ hash: delayDeployHash });
}
await assertContractCode({ safe, roles, delay, testUsdc });

const {
  roleKey,
  allowanceKey,
  selector: transferSelector,
  conditions: transferConditions,
} = compileResearcherUsdcPermission(testUsdc, env.BASE_ALLOWED_RECIPIENT);

const moduleCalls: Array<{ name: string; to: Address; data: Hex }> = [
  {
    name: "enableRolesModule",
    to: safe,
    data: encodeFunctionData({
      abi: safeSingletonDeployment.abi as Abi,
      functionName: "enableModule",
      args: [roles],
    }),
  },
  {
    name: "enableDelayModule",
    to: safe,
    data: encodeFunctionData({
      abi: safeSingletonDeployment.abi as Abi,
      functionName: "enableModule",
      args: [delay],
    }),
  },
  {
    name: "assignResearcherRole",
    to: roles,
    data: encodeFunctionData({ abi: rolesAbi, functionName: "assignRoles", args: [env.RESEARCHER_ADDRESS, [roleKey], [true]] }),
  },
  {
    name: "scopeUsdcTarget",
    to: roles,
    data: encodeFunctionData({ abi: rolesAbi, functionName: "scopeTarget", args: [roleKey, testUsdc] }),
  },
  {
    name: "scopeUsdcTransfer",
    to: roles,
    data: encodeFunctionData({
      abi: rolesAbi,
      functionName: "scopeFunction",
      args: [roleKey, testUsdc, transferSelector, transferConditions, 0],
    }),
  },
  {
    name: "setUsdcAllowance",
    to: roles,
    data: encodeFunctionData({
      abi: rolesAbi,
      functionName: "setAllowance",
      args: [allowanceKey, UAT_ALLOWANCE, 0n, 0n, 0n, 0n],
    }),
  },
  {
    name: "enableGovOnDelay",
    to: delay,
    data: encodeFunctionData({
      abi: [{ type: "function", name: "enableModule", stateMutability: "nonpayable", inputs: [{ name: "module", type: "address" }], outputs: [] }],
      functionName: "enableModule",
      args: [env.GOV_ADDRESS],
    }),
  },
];
const configurationTransactionHashes: Record<string, Hex> = {
  ...(env.RESUME_ENABLE_ROLES_TX_HASH
    ? { enableRolesModule: env.RESUME_ENABLE_ROLES_TX_HASH }
    : {}),
  ...(env.RESUME_ENABLE_DELAY_TX_HASH
    ? { enableDelayModule: env.RESUME_ENABLE_DELAY_TX_HASH }
    : {}),
  ...(env.RESUME_ASSIGN_RESEARCHER_TX_HASH
    ? { assignResearcherRole: env.RESUME_ASSIGN_RESEARCHER_TX_HASH }
    : {}),
  ...(env.RESUME_SCOPE_TARGET_TX_HASH
    ? { scopeUsdcTarget: env.RESUME_SCOPE_TARGET_TX_HASH }
    : {}),
};
let safeNonce = await publicClient.readContract({
  address: safe,
  abi: safeSingletonDeployment.abi as Abi,
  functionName: "nonce",
}) as bigint;
for (const [index, call] of moduleCalls.entries()) {
  if (index < env.RESUME_CONFIG_STEP) continue;
  const safeTransaction: SafeTransaction = {
    to: call.to,
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
  const safeTxHash = await publicClient.readContract({
    address: safe,
    abi: safeSingletonDeployment.abi as Abi,
    functionName: "getTransactionHash",
    args: safeTransactionArgs(safeTransaction),
  }) as Hex;
  const signatures = await Promise.all(
    councilAccounts.slice(0, 2).map(async (account) => ({
      owner: account.address,
      signature: await signatureFromAccount(account, safeTxHash),
    })),
  );
  const packedSignatures = concatHex(
    signatures
      .sort((left, right) => left.owner.toLowerCase().localeCompare(right.owner.toLowerCase()))
      .map(({ signature }) => signature),
  );
  const transactionHash = await walletClient.writeContract({
    address: safe,
    abi: safeSingletonDeployment.abi as Abi,
    functionName: "execTransaction",
    args: [...safeTransactionArgs(safeTransaction).slice(0, 9), packedSignatures],
    gas: 500_000n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== "success") {
    throw new Error(`Safe configuration transaction ${call.name} failed`);
  }
  configurationTransactionHashes[call.name] = transactionHash;
  safeNonce += 1n;
}

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "balance", type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "success", type: "bool" }] },
] as const;
const safeUsdcBalance = await publicClient.readContract({ address: testUsdc, abi: erc20Abi, functionName: "balanceOf", args: [safe] });
let fundSafeUsdcHash: Hex | undefined;
if (safeUsdcBalance < UAT_ALLOWANCE) {
  const missing = UAT_ALLOWANCE - safeUsdcBalance;
  const deployerUsdc = await publicClient.readContract({ address: testUsdc, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] });
  if (deployerUsdc < missing) throw new Error(`deployer needs ${missing} additional test USDC base units`);
  fundSafeUsdcHash = await walletClient.writeContract({ address: testUsdc, abi: erc20Abi, functionName: "transfer", args: [safe, missing] });
  await publicClient.waitForTransactionReceipt({ hash: fundSafeUsdcHash });
}

const agentBalance = await publicClient.getBalance({ address: env.RESEARCHER_ADDRESS });
let fundAgentGasHash: Hex | undefined;
if (agentBalance < MINIMUM_AGENT_GAS) {
  fundAgentGasHash = await walletClient.sendTransaction({ to: env.RESEARCHER_ADDRESS, value: MINIMUM_AGENT_GAS - agentBalance });
  await publicClient.waitForTransactionReceipt({ hash: fundAgentGasHash });
}

const deployedCodeHashes = await assertContractCode({ safe, roles, delay, testUsdc });
const manifest: Manifest = {
  observedAt: new Date().toISOString(),
  chainId: CHAIN_ID,
  network: "base-sepolia",
  versions: {
    safe: SAFE_VERSION,
    roles: ROLES_VERSION,
    delay: DELAY_VERSION,
    moduleProxyFactory: "1.2.0",
  },
  contracts: {
    safe,
    safeSingleton,
    safeFactory,
    multiSend,
    roles,
    rolesMastercopy: ROLES_MASTERCOPY,
    delay,
    delayMastercopy: DELAY_MASTERCOPY,
    moduleProxyFactory: MODULE_PROXY_FACTORY,
    usdc: testUsdc,
  },
  policy: {
    safeThreshold: Number(SAFE_THRESHOLD),
    councilOwner1: councilAccounts[0]!.address,
    councilOwner2: councilAccounts[1]!.address,
    councilOwner3: councilAccounts[2]!.address,
    researcher: env.RESEARCHER_ADDRESS,
    allowedRecipient: env.BASE_ALLOWED_RECIPIENT,
    usdcAllowanceBaseUnits: UAT_ALLOWANCE.toString(),
    cooldownSeconds: Number(COOLDOWN),
    expirationSeconds: Number(EXPIRATION),
    govAddress: env.GOV_ADDRESS,
    minimumAgentGasWei: MINIMUM_AGENT_GAS.toString(),
  },
  transactions: {
    deploySafe: safeDeployHash,
    deployRoles: rolesDeployHash,
    deployDelay: delayDeployHash,
    deployTestUsdc: deployTestUsdcHash,
    ...configurationTransactionHashes,
    ...(fundSafeUsdcHash ? { fundSafeUsdc: fundSafeUsdcHash } : {}),
    ...(fundAgentGasHash ? { fundAgentGas: fundAgentGasHash } : {}),
  },
  codeHashes: { ...canonicalCodeHashes, ...deployedCodeHashes },
};
const deploymentsDirectory = resolve(REPO_ROOT, "deployments");
await mkdir(deploymentsDirectory, { recursive: true });
await writeFile(
  resolve(deploymentsDirectory, "base-sepolia.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 },
);
const registry = {
  clientId: "acme",
  registryVersion: 11,
  network: "base-sepolia",
  chainId: CHAIN_ID,
  token: { symbol: "USDC", address: testUsdc, decimals: 6 },
  roles: {
    researcher: {
      maximumPayment: UAT_ALLOWANCE.toString(),
      vendors: [
        {
          id: "uat-recipient",
          name: "ACME Base Sepolia recipient",
          addresses: [
            {
              address: env.BASE_ALLOWED_RECIPIENT,
              maximumPayment: UAT_ALLOWANCE.toString(),
            },
          ],
        },
      ],
    },
  },
};
await writeFile(
  resolve(REPO_ROOT, "config/clients/acme/vendors.json"),
  `${JSON.stringify(registry, null, 2)}\n`,
  { mode: 0o644 },
);
console.log(JSON.stringify(manifest, null, 2));
