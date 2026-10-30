import { BASE_SEPOLIA } from "@mandateos/sdk/roles";
import { encodeFunctionData, erc20Abi, maxUint256, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

import { checkTransaction, parseTxInput, txCheckJob } from "./tx-check.js";

const USDC = BASE_SEPOLIA.tokens.find((token) => token.symbol === "USDC")!.address;
const ROUTER = BASE_SEPOLIA.protocols["uniswap-v3"].router;
const POOL = BASE_SEPOLIA.lending!["aave-v3"]!.pool;
const WALLET = "0x9435c2d547099D9cd9c82e29290753b590a8aF1e";
const SPENDER = "0x1111111111111111111111111111111111111111";

const call = (to: string, data: string, value = "0") => ({ chainId: 84532, to: to as `0x${string}`, data, value });

describe("tx-check", () => {
  it("describes the Uniswap swap and the Aave supply the demo company makes", () => {
    const swap = encodeFunctionData({
      abi: parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)"]),
      args: [{ tokenIn: USDC, tokenOut: BASE_SEPOLIA.weth!, fee: 500, recipient: WALLET, amountIn: 1_000_000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
    });
    const swapCheck = checkTransaction(call(ROUTER, swap));
    expect(swapCheck.description).toMatch(/^swap 1 USDC for .* on Uniswap/);
    const supply = encodeFunctionData({ abi: parseAbi(["function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)"]), args: [USDC, 2_000_000n, WALLET, 0] });
    expect(checkTransaction(call(POOL, supply)).description).toMatch(/^deposit 2 USDC into Aave/);
  });

  it("flags unlimited approvals, approvals for all, ownership and upgrades", () => {
    const unlimited = checkTransaction(call(USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SPENDER, maxUint256] })));
    expect(unlimited.risks).toContainEqual(expect.objectContaining({ severity: "high", title: "Unlimited approval" }));
    const all = checkTransaction(call(SPENDER, encodeFunctionData({ abi: parseAbi(["function setApprovalForAll(address,bool)"]), args: [WALLET, true] })));
    expect(all.risks[0]).toMatchObject({ severity: "critical" });
    const owner = checkTransaction(call(SPENDER, encodeFunctionData({ abi: parseAbi(["function transferOwnership(address)"]), args: [WALLET] })));
    expect(owner.risks[0]).toMatchObject({ severity: "critical", title: "Hands over ownership" });
    const unknown = checkTransaction(call(SPENDER, "0xdeadbeef"));
    expect(unknown.risks).toContainEqual(expect.objectContaining({ title: "Unknown function" }));
    const plain = checkTransaction(call(WALLET, "0x", "1000000000000000"));
    expect(plain.description).toMatch(/^send 0.001 ETH/);
    expect(plain.risks).toEqual([]);
  });

  it("reads JSON or key: value lines, and says what is missing", () => {
    expect(parseTxInput(`chainId: 84532\nto: ${WALLET}\nvalue: 5`)).toEqual({ chainId: 84532, to: WALLET, data: "0x", value: "5" });
    expect(() => parseTxInput("check this please")).toThrow(/to must be an address|Send JSON/);
    expect(() => parseTxInput(JSON.stringify({ chainId: 84532, to: WALLET, data: "0xabc" }))).toThrow(/hex/);
  });

  it("delivers markdown and JSON", () => {
    const delivery = txCheckJob(JSON.stringify(call(USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SPENDER, maxUint256] }))));
    expect(delivery.markdown).toMatch(/# Transaction check/);
    expect(delivery.markdown).toMatch(/\*\*high\*\* · Unlimited approval/);
    expect(delivery.json).toMatchObject({ chainId: 84532, functionName: "approve" });
  });
});
