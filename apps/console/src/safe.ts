import { getMultiSendDeployment, getProxyFactoryDeployment, getSafeL2SingletonDeployment } from "@safe-global/safe-deployments";
import {
  concatHex,
  createPublicClient,
  getAddress,
  http,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";

import type { TreasuryPlan } from "./api.js";
import { evmAccounts, evmWalletClient, switchToBaseSepolia } from "./wallets.js";

export const BASE_SEPOLIA_CHAIN_ID = 84532;
const SAFE_VERSION = "1.4.1";

export type SafeBatchSignature = { owner: Address; signature: Hex };

export interface SafeBatchCall {
  to: Address;
  value: bigint;
  data: Hex;
}

export interface SafeBatch {
  safe: Address;
  multiSend: Address;
  nonce: bigint;
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  safeTxHash: Hex;
}

const safeAbi = [
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "getTransactionHash",
    stateMutability: "view",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "_nonce", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

function multiSendAddress(): Address {
  const deployment = getMultiSendDeployment({ network: String(BASE_SEPOLIA_CHAIN_ID), version: SAFE_VERSION });
  if (!deployment) throw new Error("MultiSend deployment missing");
  return getAddress(deployment.networkAddresses[String(BASE_SEPOLIA_CHAIN_ID)] ?? deployment.defaultAddress);
}

export function encodeMultiSend(calls: SafeBatchCall[]): Hex {
  return concatHex(
    calls.map((call) =>
      concatHex([
        toHex(0, { size: 1 }),
        call.to,
        toHex(call.value, { size: 32 }),
        toHex(BigInt((call.data.length - 2) / 2), { size: 32 }),
        call.data,
      ]),
    ),
  );
}

export async function buildSafeBatch(plan: TreasuryPlan): Promise<SafeBatch> {
  const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
  const safe = getAddress(plan.base.safeAddress);
  const nonce = await client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
  const calls = plan.base.safeModuleCalls.map((call) => ({
    to: getAddress(call.to),
    value: BigInt(call.value),
    data: call.data as Hex,
  }));
  const multiSend = multiSendAddress();
  const data = encodeMultiSend(calls);
  const fields = {
    to: multiSend,
    value: 0n,
    data,
    operation: 1 as const,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
  };
  const safeTxHash = await client.readContract({
    address: safe,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: [
      fields.to,
      fields.value,
      fields.data,
      fields.operation,
      fields.safeTxGas,
      fields.baseGas,
      fields.gasPrice,
      fields.gasToken,
      fields.refundReceiver,
      nonce,
    ],
  });
  return { safe, multiSend, nonce, ...fields, safeTxHash };
}

export async function signSafeBatch(batch: SafeBatch): Promise<SafeBatchSignature> {
  await switchToBaseSepolia();
  const [owner] = await evmAccounts();
  if (!owner) throw new Error("No EVM account selected");
  const wallet = evmWalletClient();
  const signature = await wallet.signTypedData({
    account: owner,
    domain: { chainId: BASE_SEPOLIA_CHAIN_ID, verifyingContract: batch.safe },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx",
    message: {
      to: batch.to,
      value: batch.value,
      data: batch.data,
      operation: batch.operation,
      safeTxGas: batch.safeTxGas,
      baseGas: batch.baseGas,
      gasPrice: batch.gasPrice,
      gasToken: batch.gasToken,
      refundReceiver: batch.refundReceiver,
      nonce: batch.nonce,
    },
  });
  return { owner, signature };
}

export function packSignatures(signatures: SafeBatchSignature[]): Hex {
  return concatHex(
    [...signatures]
      .sort((left, right) => left.owner.toLowerCase().localeCompare(right.owner.toLowerCase()))
      .map(({ signature }) => signature),
  );
}

export async function executeSafeBatch(batch: SafeBatch, signatures: SafeBatchSignature[]): Promise<Hex> {
  await switchToBaseSepolia();
  const [account] = await evmAccounts();
  if (!account) throw new Error("No EVM account selected");
  const wallet = evmWalletClient();
  return wallet.writeContract({
    account,
    address: batch.safe,
    abi: safeAbi as Abi,
    functionName: "execTransaction",
    args: [
      batch.to,
      batch.value,
      batch.data,
      batch.operation,
      batch.safeTxGas,
      batch.baseGas,
      batch.gasPrice,
      batch.gasToken,
      batch.refundReceiver,
      packSignatures(signatures),
    ],
  });
}
