import { createPublicClient, createWalletClient, encodeFunctionData, formatEther, getAddress, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { z } from "zod";

const env = z.object({
  ETHEREUM_SEPOLIA_RPC_URL: z.string().url().default("https://ethereum-sepolia-rpc.publicnode.com"),
  BASE_DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  OMNIROLES_BRIDGE_ETH: z.string().default("0.002"),
}).parse(process.env);

const bridge = getAddress("0xfd0Bf71F60660E2f608ed56e1659C450eB113120");
const bridgeAbi = [{
  type: "function",
  name: "depositETH",
  stateMutability: "payable",
  inputs: [{ name: "minimumGasLimit", type: "uint32" }, { name: "extraData", type: "bytes" }],
  outputs: [],
}] as const;
const account = privateKeyToAccount(env.BASE_DEPLOYER_PRIVATE_KEY as `0x${string}`);
const transport = http(env.ETHEREUM_SEPOLIA_RPC_URL);
const publicClient = createPublicClient({ chain: sepolia, transport });
const walletClient = createWalletClient({ account, chain: sepolia, transport });
const value = parseEther(env.OMNIROLES_BRIDGE_ETH);
const balance = await publicClient.getBalance({ address: account.address });
if (balance <= value) {
  throw new Error(`Ethereum Sepolia wallet ${account.address} has ${formatEther(balance)} ETH; needs more than ${env.OMNIROLES_BRIDGE_ETH}`);
}
const hash = await walletClient.sendTransaction({
  to: bridge,
  value,
  data: encodeFunctionData({ abi: bridgeAbi, functionName: "depositETH", args: [200_000, "0x"] }),
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`bridge deposit reverted: ${hash}`);
console.log(JSON.stringify({ account: account.address, amount: env.OMNIROLES_BRIDGE_ETH, ethereumSepoliaTx: hash }, null, 2));
