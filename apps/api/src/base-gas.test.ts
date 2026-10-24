import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import {
  BaseGasEstimationError,
  BaseGasEstimator,
  type BaseGasGateway,
} from "./base-gas.js";

const sender = getAddress("0x1111111111111111111111111111111111111111");
const target = getAddress("0x2222222222222222222222222222222222222222");

function gateway(overrides: Partial<BaseGasGateway> = {}): BaseGasGateway {
  return {
    feeHistory: async () => ({ baseFeePerGas: [9n, 10n], rewards: [2n, 4n, 3n] }),
    estimateGas: async () => 100n,
    estimateL1Fee: async () => 50n,
    balance: async () => 10_000n,
    currentBaseFee: async () => 10n,
    ...overrides,
  };
}

const caps = {
  gasLimit: 1_000n,
  maxFeePerGas: 100n,
  maxPriorityFeePerGas: 10n,
};

describe("BaseGasEstimator", () => {
  it("adds a 30 percent gas margin and derives p50 priority plus 3x base fee", async () => {
    const estimator = new BaseGasEstimator(gateway(), caps);
    await expect(estimator.quote({ from: sender, to: target, data: "0x1234" })).resolves.toEqual({
      gasLimit: 130n,
      maxFeePerGas: 33n,
      maxPriorityFeePerGas: 3n,
      baseFeePerGas: 10n,
      l1Fee: 50n,
      senderBalance: 10_000n,
      requiredBalance: 4_340n,
      sufficientBalance: true,
    });
  });

  it("reports an insufficient sender balance including the Base L1 fee", async () => {
    const estimator = new BaseGasEstimator(gateway({ balance: async () => 4_339n }), caps);
    await expect(estimator.quote({ from: sender, to: target, data: "0x1234" }))
      .resolves.toMatchObject({ requiredBalance: 4_340n, sufficientBalance: false });
  });

  it("rejects failed estimates and values above configured caps", async () => {
    const failed = new BaseGasEstimator(gateway({ estimateGas: async () => { throw new Error("revert"); } }), caps);
    await expect(failed.quote({ from: sender, to: target, data: "0x1234" }))
      .rejects.toThrow("Base gas estimation failed: revert");

    const capped = new BaseGasEstimator(gateway({ estimateGas: async () => 1_000n }), caps);
    await expect(capped.quote({ from: sender, to: target, data: "0x1234" }))
      .rejects.toThrow("estimated gas 1300 exceeds cap 1000");
  });

  it("rejects an invalid priority fee cap at startup", () => {
    expect(() => new BaseGasEstimator(gateway(), {
      gasLimit: 1_000n,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 11n,
    })).toThrow(BaseGasEstimationError);
  });
});
