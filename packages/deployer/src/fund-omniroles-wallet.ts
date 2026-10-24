import { createPublicClient, createWalletClient, encodeFunctionData, formatEther, getAddress, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { z } from "zod";

const env = z.object({
  BASE_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia.base.org"),
  BASE_DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  OMNIROLES_WALLET_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  BASE_TEST_USDC_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  OMNIROLES_GAS_ETH: z.string().default("0.002"),
  OMNIROLES_TEST_USDC: z.coerce.bigint().positive().default(2_000_000n),
}).parse(process.env);

const tokenAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [{ name: "recipient", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const account = privateKeyToAccount(env.BASE_DEPLOYER_PRIVATE_KEY as `0x${string}`);
const walletAddress = getAddress(env.OMNIROLES_WALLET_ADDRESS);
const tokenAddress = getAddress(env.BASE_TEST_USDC_ADDRESS);
const transport = http(env.BASE_SEPOLIA_RPC_URL);
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport });
const requiredEth = parseEther(env.OMNIROLES_GAS_ETH);
const [ethBefore, tokenBefore] = await Promise.all([
  publicClient.getBalance({ address: walletAddress }),
  publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [walletAddress] }),
]);

let ethFundingHash: `0x${string}` | null = null;
if (ethBefore < requiredEth) {
  ethFundingHash = await walletClient.sendTransaction({
    to: walletAddress,
    value: requiredEth - ethBefore,
  });
  await publicClient.waitForTransactionReceipt({ hash: ethFundingHash });
}

let tokenFundingHash: `0x${string}` | null = null;
if (tokenBefore < env.OMNIROLES_TEST_USDC) {
  tokenFundingHash = await walletClient.sendTransaction({
    to: tokenAddress,
    data: encodeFunctionData({
      abi: tokenAbi,
      functionName: "transfer",
      args: [walletAddress, env.OMNIROLES_TEST_USDC - tokenBefore],
    }),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tokenFundingHash });
  if (receipt.status !== "success") throw new Error(`TestUSDC funding reverted: ${tokenFundingHash}`);
}

const [ethAfter, tokenAfter] = await Promise.all([
  publicClient.getBalance({ address: walletAddress }),
  publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [walletAddress] }),
]);
console.log(JSON.stringify({
  walletAddress,
  ethBefore: formatEther(ethBefore),
  ethAfter: formatEther(ethAfter),
  tokenBefore: tokenBefore.toString(),
  tokenAfter: tokenAfter.toString(),
  ethFundingHash,
  tokenFundingHash,
}, null, 2));
