import { describe, expect, it } from "vitest";
import { hexToBytes } from "viem";

import { batchCalls, digestSponsoredBatch } from "./evm.js";
import type { VaultOperation } from "./types.js";

// Same inputs as the vault's `batch_digest_and_calldata_match_viem` (contracts/vault/src/sponsored.rs):
// the Guard and the vault must agree on the digest MPC signs.
const bytes = (hex: string) => Array.from(hexToBytes(hex as `0x${string}`));
const operation = {
  op_id: Array(32).fill(0xab),
  request: { chain_id: 84532, target: bytes("0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4"), value: "5", calldata: [0x04, 0xe4, 0x5a, 0xaf, ...Array(37).fill(0x11)] },
} as unknown as VaultOperation;
const approval = { token: bytes("0x036CbD53842c5426634e7929541eC2318f3dCF7e"), amount: "4000000" };

describe("sponsored batch (approve + call + revoke)", () => {
  it("approves the call's own target, then revokes it", () => {
    const [approve, call, revoke] = batchCalls(operation, approval);
    expect(approve!.data.slice(0, 10)).toBe("0x095ea7b3");
    expect(approve!.data.toLowerCase()).toContain("94cc0aac535ccdb3c01d6787d6413c739ae12bc4");
    expect(call!.to.toLowerCase()).toBe("0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4");
    expect(revoke!.data.endsWith("0".repeat(64))).toBe(true);
  });

  it("matches the vault's digest", () => {
    expect(digestSponsoredBatch(operation, "0x1db9bad1d7f4effed814dfc7a0dc5d5aef0f2303", 1794242060n, approval))
      .toBe("0x4558b98c1c2ca713c373d288b1605d1c28bff539a2c5f6c54f213a482437df16");
  });
});
