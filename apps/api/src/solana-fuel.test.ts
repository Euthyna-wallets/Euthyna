import { describe, expect, it } from "vitest";

import { SolanaFuel, solanaTankSeed } from "./solana-fuel.js";

const WALLET = "Aeo7Nbs7U4trXo49Uf1bxVw5D1JWc9hFihv1xSsJkvZr";

function fuel(balances: Record<string, number>, sent: string[], options: Partial<ConstructorParameters<typeof SolanaFuel>[0]> = {}) {
  const service = new SolanaFuel({
    seed: solanaTankSeed(undefined, "ed25519:relayer"),
    rpc: (async (method: string, params: unknown[]) => {
      if (method === "getBalance") return { value: balances[params[0] as string] ?? 0 };
      if (method === "getLatestBlockhash") return { value: { blockhash: "11111111111111111111111111111111" } };
      if (method === "sendTransaction") { sent.push(params[0] as string); return `sig${sent.length}`; }
      throw new Error(method);
    }) as never,
    readWallet: async (vault) => (vault === "none.testnet" ? null : WALLET),
    belowLamports: 3_000_000n,
    toLamports: 10_000_000n,
    perVaultPerDay: 2,
    totalPerDayLamports: 50_000_000n,
    now: () => 0,
    ...options,
  });
  return service;
}

describe("SolanaFuel", () => {
  it("tops a low wallet up to the target, from the tank", async () => {
    const sent: string[] = [];
    const probe = fuel({}, []);
    const balances = { [WALLET]: 1_000_000, [probe.address]: 1_000_000_000 };
    const funded = fuel(balances, sent);
    await expect(funded.fuel("v.testnet")).resolves.toMatchObject({ status: "funded", lamports: "9000000", address: WALLET });
    expect(sent).toHaveLength(1);
  });

  it("does nothing when the wallet has enough, or has no Solana wallet", async () => {
    const sent: string[] = [];
    const service = fuel({ [WALLET]: 5_000_000 }, sent);
    await expect(service.fuel("v.testnet")).resolves.toMatchObject({ status: "enough" });
    await expect(service.fuel("none.testnet")).resolves.toEqual({ status: "no_wallet" });
    expect(sent).toHaveLength(0);
  });

  it("caps per vault per day, and refuses when the tank is empty", async () => {
    const sent: string[] = [];
    const probe = fuel({}, sent);
    const service = fuel({ [WALLET]: 0, [probe.address]: 1_000_000_000 }, sent);
    await service.fuel("v.testnet");
    await service.fuel("v.testnet");
    await expect(service.fuel("v.testnet")).resolves.toMatchObject({ status: "capped" });
    const empty = fuel({ [WALLET]: 0, [probe.address]: 5_000_000 }, []);
    await expect(empty.fuel("v.testnet")).resolves.toMatchObject({ status: "tank_empty" });
  });

  it("derives a stable tank key from the relayer key, or takes an explicit one", () => {
    expect(Buffer.from(solanaTankSeed(undefined, "a")).equals(Buffer.from(solanaTankSeed(undefined, "a")))).toBe(true);
    expect(Buffer.from(solanaTankSeed(undefined, "a")).equals(Buffer.from(solanaTankSeed(undefined, "b")))).toBe(false);
    expect(solanaTankSeed("4uQeVj5tqViQh7yWWV2JbsJNQjYcQAzb6K7qBR7bZ8WX", "a")).toHaveLength(32);
  });
});
