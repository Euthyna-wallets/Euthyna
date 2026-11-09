import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";

import { keepDelegated, type DelegationChain, type DelegationNear } from "./delegation-keeper.js";

const executor = `0x${"cc".repeat(20)}`;
const wallet = Array(20).fill(0x11);

function fakes(state: { executor?: string | null; code?: Hex; delegation?: unknown }) {
  const calls: string[] = [];
  const submitted: unknown[] = [];
  const near: DelegationNear = {
    viewFunction<T>(_id: string, method: string) {
      if (method === "get_evm_executor") return Promise.resolve((state.executor ?? null) as T);
      if (method === "get_wallet") return Promise.resolve({ address: wallet } as T);
      if (method === "get_wallet_delegation") return Promise.resolve((state.delegation ?? null) as T);
      throw new Error(method);
    },
    delegateWallet: () => { calls.push("delegate_wallet"); return Promise.resolve("tx"); },
  };
  const chain: DelegationChain = {
    code: (_a: Address) => Promise.resolve(state.code),
    delegate: (a) => { submitted.push(a); return Promise.resolve(`0x${"ab".repeat(32)}` as Hex); },
  };
  return { near, chain, calls, submitted };
}

describe("keepDelegated", () => {
  it("does nothing without a voted executor", async () => {
    const f = fakes({});
    expect(await keepDelegated(f.near, f.chain, "v", 84532)).toBe("none");
    expect(f.calls).toEqual([]);
  });

  it("leaves a wallet already delegated to the executor alone", async () => {
    const f = fakes({ executor, code: `0xef0100${"CC".repeat(20)}` as Hex });
    expect(await keepDelegated(f.near, f.chain, "v", 84532)).toBe("delegated");
    expect(f.calls).toEqual([]);
    expect(f.submitted).toEqual([]);
  });

  it("asks the vault to sign when there is no signature, or one for another executor", async () => {
    const f = fakes({ executor, code: "0x" });
    expect(await keepDelegated(f.near, f.chain, "v", 84532)).toBe("signing");
    const g = fakes({ executor, code: "0x", delegation: { executor: Array(20).fill(0xdd), nonce: 0, signature: { big_r: [2, ...Array(32).fill(1)], s: Array(32).fill(2), recovery_id: 1 } } });
    expect(await keepDelegated(g.near, g.chain, "v", 84532)).toBe("signing");
    expect([...f.calls, ...g.calls]).toEqual(["delegate_wallet", "delegate_wallet"]);
  });

  it("submits the signed authorization with r taken from big_r's x coordinate", async () => {
    const f = fakes({ executor, code: "0x", delegation: { executor: Array(20).fill(0xcc), nonce: 3, signature: { big_r: [3, ...Array(32).fill(1)], s: Array(32).fill(2), recovery_id: 1 } } });
    expect(await keepDelegated(f.near, f.chain, "v", 84532)).toBe("submitted");
    expect(f.submitted).toEqual([{ chainId: 84532, address: executor, nonce: 3, r: `0x${"01".repeat(32)}`, s: `0x${"02".repeat(32)}`, yParity: 1 }]);
  });
});
