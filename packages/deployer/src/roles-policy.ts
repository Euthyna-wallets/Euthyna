import { getAddress, type Address, type Hex } from "viem";
import { c, encodeKey, flattenCondition, processPermissions, rolesAbi } from "zodiac-roles-sdk";

export { rolesAbi };

export interface FlatCondition {
  parent: number;
  paramType: number;
  operator: number;
  compValue: Hex;
}

export interface CompiledUsdcPermission {
  roleKey: Hex;
  allowanceKey: Hex;
  target: Address;
  selector: Hex;
  conditions: FlatCondition[];
}

export function compileResearcherUsdcPermission(
  token: Address,
  recipient: Address,
): CompiledUsdcPermission {
  const roleKey = encodeKey("researcher");
  const allowanceKey = encodeKey("researcher-usdc");
  const permission = {
    targetAddress: getAddress(token),
    signature: "transfer(address,uint256)",
    condition: c.calldataMatches(
      [getAddress(recipient), c.withinAllowance("researcher-usdc")],
      ["address", "uint256"],
    ),
  };
  const target = processPermissions([[permission]]).targets[0];
  const functionPermission = target?.functions[0];
  if (!target || !functionPermission?.condition) {
    throw new Error("failed to compile the USDC transfer permission");
  }
  return {
    roleKey,
    allowanceKey,
    target: getAddress(target.address),
    selector: functionPermission.selector,
    conditions: flattenCondition(functionPermission.condition).map((condition) => ({
      parent: condition.parent,
      paramType: condition.paramType,
      operator: condition.operator,
      compValue: (condition.compValue ?? "0x") as Hex,
    })),
  };
}

export function compilePaymentPermission(input: {
  role: string;
  token: Address;
  recipients: Address[];
}): CompiledUsdcPermission {
  if (input.recipients.length === 0) throw new Error("at least one recipient is required");
  const allowanceKey = encodeKey(`${input.role}-${input.token.slice(2, 8).toLowerCase()}`);
  const branches = input.recipients.map((recipient) =>
    c.calldataMatches(
      [getAddress(recipient), c.withinAllowance(allowanceKey)],
      ["address", "uint256"],
    ),
  );
  const [first, ...rest] = branches;
  if (!first) throw new Error("at least one recipient is required");
  const permission = {
    targetAddress: getAddress(input.token),
    signature: "transfer(address,uint256)",
    condition: rest.length === 0 ? first : c.or(first, ...(rest as [typeof first, ...(typeof first)[]])),
  };
  const target = processPermissions([[permission]]).targets[0];
  const functionPermission = target?.functions[0];
  if (!target || !functionPermission?.condition) {
    throw new Error("failed to compile the payment permission");
  }
  return {
    roleKey: encodeKey(input.role),
    allowanceKey,
    target: getAddress(target.address),
    selector: functionPermission.selector,
    conditions: flattenCondition(functionPermission.condition).map((condition) => ({
      parent: condition.parent,
      paramType: condition.paramType,
      operator: condition.operator,
      compValue: (condition.compValue ?? "0x") as Hex,
    })),
  };
}
