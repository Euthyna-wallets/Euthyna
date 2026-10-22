import { describe, expect, it } from "vitest";
import { encodeAbiParameters, getAddress, parseAbiParameters } from "viem";
import { Operator, ParameterType } from "zodiac-roles-sdk";
import { compileResearcherUsdcPermission } from "./roles-policy.js";
import { canonicalMultiSendCallOnlyAddress } from "./treasury-plan.js";
const usdc = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7c");
const recipient = getAddress("0x1111111111111111111111111111111111111111");

describe("researcher USDC permission", () => {
  it("requires the exact recipient and meters amount through the shared allowance key", () => {
    const permission = compileResearcherUsdcPermission(usdc, recipient);
    expect(permission.target).toBe(usdc);
    expect(permission.selector).toBe("0xa9059cbb");
    expect(permission.conditions).toHaveLength(3);
    expect(permission.conditions[0]).toMatchObject({
      parent: 0,
      paramType: ParameterType.Calldata,
      operator: Operator.Matches,
    });
    expect(permission.conditions[1]).toEqual({
      parent: 0,
      paramType: ParameterType.Static,
      operator: Operator.EqualTo,
      compValue: encodeAbiParameters(parseAbiParameters("address"), [recipient]),
    });
    expect(permission.conditions[2]).toMatchObject({
      parent: 0,
      paramType: ParameterType.Static,
      operator: Operator.WithinAllowance,
      compValue: permission.allowanceKey,
    });
  });
  it("pins Base Sepolia to Safe 1.4.1 MultiSendCallOnly", () => {
    expect(canonicalMultiSendCallOnlyAddress(84532)).toBe(
      getAddress("0x9641d764fc13c8B624c04430C7356C1C7C8102e2"),
    );
  });
});
