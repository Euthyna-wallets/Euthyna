import { encodeDeployProxy, predictProxyAddress } from "@gnosis-guild/zodiac-core";
import { getMultiSendDeployment, getProxyFactoryDeployment, getSafeL2SingletonDeployment } from "@safe-global/safe-deployments";
import {
  bytesToBigInt,
  bytesToHex,
  concatHex,
  createPublicClient,
  encodeFunctionData,
  encodePacked,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  padHex,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { base, baseSepolia } from "viem/chains";

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const SAFE_VERSION = "1.4.1";
export const ROLES_VERSION = "2.1.1";
export const DELAY_VERSION = "1.1.1";
export const DELAY_COOLDOWN_SECONDS = 300n;
export const DELAY_EXPIRATION_SECONDS = 604_800n;
export const ROLES_MASTERCOPY = getAddress("0xf2964ce6161ce0e75964fe7927ce114cb0b283d5");
export const DELAY_MASTERCOPY = getAddress("0x824175b945838d127c1ca83cbce11d8e44f6df01");
export const MODULE_PROXY_FACTORY = getAddress("0x000000000000aDdB49795b0f9bA5BC298cDda236");
export const SAFE_FALLBACK_HANDLER = getAddress("0xfd0732dc9e303f09fcef3a7388ad10a83459ec99");

const safeSetupAbi = [
  {
    type: "function",
    name: "setup",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owners", type: "address[]" },
      { name: "_threshold", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "fallbackHandler", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint256" },
      { name: "paymentReceiver", type: "address" },
    ],
    outputs: [],
  },
] as const;

const safeModuleAbi = [
  {
    type: "function",
    name: "enableModule",
    stateMutability: "nonpayable",
    inputs: [{ name: "module", type: "address" }],
    outputs: [],
  },
] as const;

const proxyFactoryAbi = [
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
  {
    type: "function",
    name: "proxyCreationCode",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

export interface UnsignedEvmTransaction {
  to: Address;
  value: string;
  data: Hex;
  chainId: number;
  description: string;
}

export interface BaseTreasuryPlan {
  chainId: number;
  safeAddress: Address;
  safeDeployment: UnsignedEvmTransaction;
  rolesAddress: Address;
  rolesDeployment: UnsignedEvmTransaction;
  delayAddress: Address;
  delayDeployment: UnsignedEvmTransaction;
  multiSendAddress: Address;
  safeModuleCalls: Array<{ to: Address; value: string; data: Hex; description: string }>;
  saltNonces: { safe: string; roles: string; delay: string };
}

export interface BaseTreasuryPlanInput {
  organizationId: string;
  slug: string;
  owners: Address[];
  threshold: number;
  govAddress: Address;
  rpcUrl: string;
  chainId?: number;
  /** Test seam: skip the RPC read of SafeProxyFactory.proxyCreationCode(). */
  proxyCreationCode?: Hex;
}
export interface MultiSendTransaction {
  operation: 0 | 1;
  to: Address;
  value: bigint;
  data: Hex;
}

export function encodeMultiSendTransactions(calls: MultiSendTransaction[]): Hex {
  return concatHex(calls.map((call) => concatHex([
    toHex(call.operation, { size: 1 }),
    call.to,
    toHex(call.value, { size: 32 }),
    toHex(BigInt((call.data.length - 2) / 2), { size: 32 }),
    call.data,
  ])));
}
export function decodeMultiSendTransactions(value: Hex): MultiSendTransaction[] {
  const bytes = hexToBytes(value);
  const calls: MultiSendTransaction[] = [];
  for (let cursor = 0; cursor < bytes.length;) {
    if (cursor + 85 > bytes.length) throw new Error("truncated MultiSend transaction");
    const operation = bytes[cursor];
    if (operation !== 0 && operation !== 1) throw new Error(`invalid MultiSend operation ${String(operation)}`);
    const to = getAddress(bytesToHex(bytes.slice(cursor + 1, cursor + 21)));
    const value = bytesToBigInt(bytes.slice(cursor + 21, cursor + 53));
    const dataLength = Number(bytesToBigInt(bytes.slice(cursor + 53, cursor + 85)));
    const dataStart = cursor + 85;
    const dataEnd = dataStart + dataLength;
    if (dataEnd > bytes.length) throw new Error("truncated MultiSend calldata");
    calls.push({ operation, to, value, data: bytesToHex(bytes.slice(dataStart, dataEnd)) });
    cursor = dataEnd;
  }
  return calls;
}



function deploymentAddress(
  deployment:
    | ReturnType<typeof getSafeL2SingletonDeployment>
    | ReturnType<typeof getProxyFactoryDeployment>
    | ReturnType<typeof getMultiSendDeployment>,
  name: string,
  chainId: number,
): Address {
  if (!deployment) throw new Error(`${name} ${SAFE_VERSION} is not registered on chain ${chainId}`);
  const address = deployment.networkAddresses[String(chainId)] ?? deployment.defaultAddress;
  return getAddress(address);
}
export function canonicalMultiSendAddress(chainId: number): Address {
  return deploymentAddress(
    getMultiSendDeployment({ network: String(chainId), version: SAFE_VERSION }),
    "MultiSend",
    chainId,
  );
}


function safeSetupInitializer(owners: Address[], threshold: number): Hex {
  return encodeFunctionData({
    abi: safeSetupAbi,
    functionName: "setup",
    args: [owners, BigInt(threshold), zeroAddress, "0x", SAFE_FALLBACK_HANDLER, zeroAddress, 0n, zeroAddress],
  });
}

function predictSafeAddress(
  factory: Address,
  singleton: Address,
  initializer: Hex,
  saltNonce: bigint,
  proxyCreationCode: Hex,
): Address {
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(initializer), saltNonce]));
  const initCode = concatHex([proxyCreationCode, padHex(singleton, { size: 32 })]);
  const hash = keccak256(concatHex([toHex(0xff, { size: 1 }), factory, salt, keccak256(initCode)]));
  return getAddress(`0x${hash.slice(-40)}`);
}

/**
 * Builds the unsigned Base transactions for a new treasury.
 *
 * The Safe is deployed first because Zodiac module proxies are initialised with
 * the Safe as owner, avatar and target. Enabling the modules is a separate Safe
 * batch signed by the council; it cannot happen inside `setup` without a
 * circular dependency between the Safe address and the module addresses.
 */
export async function buildBaseTreasuryPlan(input: BaseTreasuryPlanInput): Promise<BaseTreasuryPlan> {
  if (input.owners.length === 0) throw new Error("at least one Safe owner is required");
  if (input.threshold < 1 || input.threshold > input.owners.length) throw new Error("invalid Safe threshold");
  const chainId = input.chainId ?? BASE_SEPOLIA_CHAIN_ID;
  const chain = chainId === 8453 ? base : baseSepolia;

  const compartment = `mandateos:${input.organizationId}:${input.slug}`;
  const safeSalt = BigInt(keccak256(stringToHex(`${compartment}:safe:${SAFE_VERSION}`)));
  const rolesSalt = BigInt(keccak256(stringToHex(`${compartment}:roles:${ROLES_VERSION}`)));
  const delaySalt = BigInt(keccak256(stringToHex(`${compartment}:delay:${DELAY_VERSION}`)));

  const singletonDeployment = getSafeL2SingletonDeployment({ network: String(chainId), version: SAFE_VERSION });
  const factoryDeployment = getProxyFactoryDeployment({ network: String(chainId), version: SAFE_VERSION });
  const multiSendDeployment = getMultiSendDeployment({ network: String(chainId), version: SAFE_VERSION });
  const singleton = deploymentAddress(singletonDeployment, "SafeL2", chainId);
  const factory = deploymentAddress(factoryDeployment, "SafeProxyFactory", chainId);
  const multiSend = canonicalMultiSendAddress(chainId);
  if (!singletonDeployment || !factoryDeployment || !multiSendDeployment) throw new Error("Safe deployments missing");

  const proxyCreationCode =
    input.proxyCreationCode ??
    ((await createPublicClient({ chain, transport: http(input.rpcUrl) }).readContract({
      address: factory,
      abi: proxyFactoryAbi,
      functionName: "proxyCreationCode",
    })) as Hex);

  const initializer = safeSetupInitializer(input.owners, input.threshold);
  const safeAddress = predictSafeAddress(factory, singleton, initializer, safeSalt, proxyCreationCode);

  const rolesSetup = { types: ["address", "address", "address"], values: [safeAddress, safeAddress, safeAddress] };
  const rolesAddress = getAddress(
    predictProxyAddress({ factory: MODULE_PROXY_FACTORY, mastercopy: ROLES_MASTERCOPY, setupArgs: rolesSetup, saltNonce: rolesSalt }),
  );
  const rolesTransaction = encodeDeployProxy({
    factory: MODULE_PROXY_FACTORY,
    mastercopy: ROLES_MASTERCOPY,
    setupArgs: rolesSetup,
    saltNonce: rolesSalt,
  });

  const delaySetup = {
    types: ["address", "address", "address", "uint256", "uint256"],
    values: [safeAddress, safeAddress, safeAddress, DELAY_COOLDOWN_SECONDS, DELAY_EXPIRATION_SECONDS],
  };
  const delayAddress = getAddress(
    predictProxyAddress({ factory: MODULE_PROXY_FACTORY, mastercopy: DELAY_MASTERCOPY, setupArgs: delaySetup, saltNonce: delaySalt }),
  );
  const delayTransaction = encodeDeployProxy({
    factory: MODULE_PROXY_FACTORY,
    mastercopy: DELAY_MASTERCOPY,
    setupArgs: delaySetup,
    saltNonce: delaySalt,
  });

  const safeModuleCalls = [
    {
      to: safeAddress,
      value: "0",
      data: encodeFunctionData({ abi: safeModuleAbi, functionName: "enableModule", args: [rolesAddress] }),
      description: "Enable Zodiac Roles on the Safe",
    },
    {
      to: safeAddress,
      value: "0",
      data: encodeFunctionData({ abi: safeModuleAbi, functionName: "enableModule", args: [delayAddress] }),
      description: "Enable Zodiac Delay on the Safe",
    },
    {
      to: delayAddress,
      value: "0",
      data: encodeFunctionData({ abi: safeModuleAbi, functionName: "enableModule", args: [input.govAddress] }),
      description: "Allow 0xGOV as the Delay module",
    },
  ];

  return {
    chainId,
    safeAddress,
    safeDeployment: {
      to: factory,
      value: "0",
      data: encodeFunctionData({
        abi: proxyFactoryAbi,
        functionName: "createProxyWithNonce",
        args: [singleton, initializer, safeSalt],
      }),
      chainId,
      description: `Deploy Safe ${SAFE_VERSION}`,
    },
    rolesAddress,
    rolesDeployment: {
      to: getAddress(String(rolesTransaction.to)),
      value: "0",
      data: rolesTransaction.data as Hex,
      chainId,
      description: `Deploy Zodiac Roles ${ROLES_VERSION}`,
    },
    delayAddress,
    multiSendAddress: multiSend,
    delayDeployment: {
      to: getAddress(String(delayTransaction.to)),
      value: "0",
      data: delayTransaction.data as Hex,
      chainId,
      description: `Deploy Zodiac Delay ${DELAY_VERSION}`,
    },
    safeModuleCalls,
    saltNonces: { safe: safeSalt.toString(), roles: rolesSalt.toString(), delay: delaySalt.toString() },
  };
}
