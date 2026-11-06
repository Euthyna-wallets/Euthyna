import { describe, expect, it } from "vitest";
import { exactInputSingleCalldata, minOut, parseOrder, rateFromPrice, rateOf, RATE_SCALE, serializeOrder, vaultTag } from "./sealed-orders.js";

describe("sealed orders, as contracts/sealed-orders computes them", () => {
  it("takes the same minimum output as the contract's unit test", () => {
    // contracts/sealed-orders: min_out_applies_rate_and_slippage
    const rate = 400_000_000n * RATE_SCALE;
    expect(minOut(1_000_000_000n, rate, 0)).toBe(400_000_000_000_000_000n);
    expect(minOut(1_000_000_000n, rate, 50)).toBe(398_000_000_000_000_000n);
  });

  it("builds the same calldata as the contract's unit test", () => {
    // contracts/sealed-orders: calldata_is_exact_input_single
    const data = exactInputSingleCalldata({
      tokenIn: `0x${"aa".repeat(20)}`, tokenOut: `0x${"bb".repeat(20)}`, fee: 3000,
      recipient: `0x${"cc".repeat(20)}`, amountIn: 5n, amountOutMinimum: 7n,
    });
    const bytes = Buffer.from(data.slice(2), "hex");
    expect(bytes.length).toBe(4 + 7 * 32);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("04e45aaf");
    expect(bytes.subarray(4 + 3 * 32 - 2, 4 + 3 * 32).toString("hex")).toBe("0bb8");
    expect(bytes[4 + 6 * 32 - 1]).toBe(7);
  });

  it("tags a vault as the contract and prove.mjs do", () => {
    // The sandbox test checks the contract against prove.mjs; this pins the shared vector.
    expect(`0x${vaultTag("acme-vault.test.near").toString(16).padStart(64, "0")}`).toBe(
      "0x003c92d1d1219069589de729a3f0da37a2bb0206ac80fcb5e6a95ae8746b4e09",
    );
  });

  it("turns a price into a rate and a quote into a rate", () => {
    // 2500 USDC per WETH: 1 USDC unit (1e-6) buys 4e8 wei.
    expect(rateFromPrice(2500, 6, 18)).toBe(400_000_000n * RATE_SCALE);
    expect(rateOf(1_000_000n, 559_270_439_304_943n)).toBe(559_270_439_304_943n * RATE_SCALE / 1_000_000n);
  });

  it("round-trips an order through its stored form", () => {
    const order = {
      vaultId: "acme.nomos.euthyna.testnet", chainId: 84532,
      tokenIn: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", tokenOut: "0x4200000000000000000000000000000000000006",
      fee: 3000, limitRate: 3n * 10n ** 26n, cap: 8_000_000n, expiry: 1_800_000_000, salt: 0x1234n,
    } as const;
    expect(parseOrder(serializeOrder(order))).toEqual(order);
  });
});
