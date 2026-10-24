import { describe, expect, it } from "vitest";

import { loadEnv } from "./env.js";

const required = {
  GUARD_ED25519_PRIVATE_KEY_BASE64: "guard",
  NEAR_RELAYER_ACCOUNT_ID: "relayer.testnet",
  NEAR_RELAYER_PRIVATE_KEY: "ed25519:test",
  DATABASE_URL: "postgresql://localhost/mandateos",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BUDGET_TOKEN_ACCOUNT_ID: "test-ft.testnet",
};

describe("Base gas cap configuration", () => {
  it("rejects a priority fee cap above the max fee cap at startup", () => {
    expect(() => loadEnv({
      ...required,
      BASE_TX_MAX_FEE_PER_GAS_CAP_WEI: "10",
      BASE_TX_MAX_PRIORITY_FEE_PER_GAS_CAP_WEI: "11",
    })).toThrow("must not exceed");
  });

  it("accepts equal priority and max fee caps", () => {
    expect(loadEnv({
      ...required,
      BASE_TX_MAX_FEE_PER_GAS_CAP_WEI: "10",
      BASE_TX_MAX_PRIORITY_FEE_PER_GAS_CAP_WEI: "10",
      GOVERNANCE_MAX_FEE_FLOOR_WEI: "10",
    })).toMatchObject({
      BASE_TX_MAX_FEE_PER_GAS_CAP_WEI: "10",
      BASE_TX_MAX_PRIORITY_FEE_PER_GAS_CAP_WEI: "10",
    });
  });

  it("rejects a governance floor above the max fee cap", () => {
    expect(() => loadEnv({
      ...required,
      BASE_TX_MAX_FEE_PER_GAS_CAP_WEI: "10",
      BASE_TX_MAX_PRIORITY_FEE_PER_GAS_CAP_WEI: "1",
      GOVERNANCE_MAX_FEE_FLOOR_WEI: "11",
    })).toThrow("GOVERNANCE_MAX_FEE_FLOOR_WEI");
  });
});
