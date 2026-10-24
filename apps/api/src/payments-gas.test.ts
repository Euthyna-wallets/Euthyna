import type { PrismaClient } from "@mandateos/db";
import { describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";

import type { BaseGasQuoter } from "./base-gas.js";
import type { Guard } from "./guard.js";
import type { NearClient } from "./near.js";
import { PaymentService } from "./payments.js";
import type { RegistryService } from "./registry-db.js";

const agentAddress = getAddress("0x1111111111111111111111111111111111111111");
const token = getAddress("0x3333333333333333333333333333333333333333");
const recipient = getAddress("0x4444444444444444444444444444444444444444");

function service() {
  const quote = vi.fn(async (input: { from: string; to: string; data: Hex }) => ({
    gasLimit: 120_000n,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    baseFeePerGas: 6_333_333_333n,
    l1Fee: 10_000n,
    senderBalance: 10n ** 18n,
    requiredBalance: 2_400_000_000_010_000n,
    sufficientBalance: true,
  }));
  const prisma = {
    treasury: { findFirst: async () => ({ id: "treasury-1" }) },
  } as unknown as PrismaClient;
  const near = {
    viewFunction: async (_account: string, method: string) => {
      if (method === "get_role") {
        return {
          config: {
            gas_limit: "300000",
            max_fee_per_gas: "100000000000",
            max_priority_fee_per_gas: "10000000000",
          },
        };
      }
      if (method === "get_wallet") {
        return { address: Array.from(Buffer.from(agentAddress.slice(2), "hex")) };
      }
      throw new Error(`unexpected view ${method}`);
    },
  } as unknown as NearClient;
  const gasEstimator = { quote, currentBaseFee: async () => 1n } as BaseGasQuoter;
  return {
    quote,
    payments: new PaymentService(
      prisma,
      near,
      {} as Guard,
      {} as RegistryService,
      gasEstimator,
    ),
  };
}

describe("PaymentService gas quote", () => {
  it("estimates the direct token call from the shared ACME wallet and returns EIP-1559 fields", async () => {
    const test = service();
    await expect(test.payments.gasQuote("org-1", {
      nearAccountId: "agent.testnet",
      vaultAccountId: "vault.testnet",
      role: "researcher",
    }, {
      token,
      recipient,
      amount: "1000000",
    })).resolves.toMatchObject({
      gas: {
        gasLimit: "120000",
        maxFeePerGas: "20000000000",
        maxPriorityFeePerGas: "1000000000",
        sufficientBalance: true,
      },
      warnings: [],
    });
    expect(test.quote).toHaveBeenCalledWith(expect.objectContaining({
      from: agentAddress,
      to: token,
      data: expect.stringMatching(/^0x[0-9a-f]+$/),
    }));
  });
});
