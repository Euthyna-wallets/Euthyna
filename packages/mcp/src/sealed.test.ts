import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { commitmentOf } from "@euthyna/sdk/sealed-prover";
import { parseOrder } from "@euthyna/sdk/sealed-orders";

import { SealedOrdersMcp, type SealedAgentLike } from "./sealed.js";

const VAULT = "acme.nomos.euthyna.testnet";
const terms = {
  vaultId: VAULT, chainId: 84532, tokenIn: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", tokenOut: "0x4200000000000000000000000000000000000006",
  fee: 3000, limitRate: "300000000000000000000000000", cap: "5000000", expiry: 1_900_000_000, salt: "0x1234",
};

function fake() {
  const settled: string[] = [];
  const agent: SealedAgentLike = {
    place: async () => ({ file: { order: terms, vault: VAULT, role: "desk", id: 4, sealedAccountId: "sealed.testnet", commitment: "0x01" }, transactions: ["tx1"] }),
    orders: async () => [{ id: 4, vault: VAULT, role: "desk", chain_id: 84532, wallet: "0x1", sealer: "agent.testnet", commitment: "0x01", slippage_bps: 50, filled: "2000000", fills: 1, cancelled: false, sealed_at_ns: "0", terms: null },
      { id: 5, vault: VAULT, role: "desk", chain_id: 84532, wallet: "0x1", sealer: "dao.testnet", commitment: "0x02", slippage_bps: 50, filled: "0", fills: 0, cancelled: false, sealed_at_ns: "0", terms: "x" }],
    tick: async () => ({ status: "filled", amountIn: 2_000_000n, rate: 1n, transaction: "fill-tx", opId: [7] }),
    settle: async (_vault, opId) => { settled.push(opId.join()); return "PossiblySigned"; },
  };
  return { agent, settled };
}

describe("sealed orders over MCP", () => {
  it("keeps the order file private, lists terms only for the agent's own orders, and fills", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sealed-")), "orders");
    const { agent, settled } = fake();
    const mcp = new SealedOrdersMcp(agent, VAULT, "desk", dir);

    const placed = await mcp.place({ maxPriceUsdc: 2000, capUsdc: "5", days: 2 });
    expect(placed.id).toBe(4);
    expect(statSync(placed.orderFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(placed.orderFile, "utf8")).order.cap).toBe("5000000");

    const listed = await mcp.list();
    expect(listed.find((order) => order.id === 4)?.yourTerms?.capUsdc).toBe("5");
    expect(listed.find((order) => order.id === 5)).not.toHaveProperty("yourTerms");

    const filled = await mcp.fill({});
    expect(filled).toEqual([{ id: 4, status: "filled", amountUsdc: "2", sell: "USDC", nearTransaction: "fill-tx", swapsAwaitingSettlement: 1 }]);
    // The swap still waits for Base finality: the next call settles it first.
    await mcp.fill({});
    expect(settled).toEqual(["7", "7", "7"]);
  });

  it("passes the token sold to the agent and names it in what it returns (EURC)", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sealed-")), "orders");
    const { agent } = fake();
    const eurc = { ...terms, tokenIn: "0x623ef90571256F905B2Fde947dC33098BdD8F4d8" };
    let asked: unknown;
    agent.place = async (input) => { asked = input.sell; return { file: { order: eurc, vault: VAULT, role: "desk", id: 4, sealedAccountId: "sealed.testnet", commitment: "0x01" }, transactions: ["tx1"] }; };
    agent.tick = async () => ({ status: "no-funds", amountIn: 2_000_000n, balance: 1_000_000n });
    const mcp = new SealedOrdersMcp(agent, VAULT, "desk", dir);
    await mcp.place({ maxPriceUsdc: 100000, capUsdc: "0.05", days: 1, sell: "EURC" });
    expect(asked).toBe("EURC");
    expect((await mcp.list()).find((order) => order.id === 4)?.yourTerms?.sell).toBe("EURC");
    expect(await mcp.fill({})).toEqual([expect.objectContaining({ status: "no-funds", reason: "the wallet holds 1 EURC, under the 2 to fill" })]);
  });

  it("takes over a member's order only when its terms hash to an open order of this company", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sealed-")), "orders");
    const { agent } = fake();
    const commitment = (await commitmentOf(parseOrder(terms))).toLowerCase();
    agent.orders = async () => [{ id: 9, vault: VAULT, role: "desk", chain_id: 84532, wallet: "0x1", sealer: "dao.testnet", commitment, slippage_bps: 50, filled: "0", fills: 0, cancelled: false, sealed_at_ns: "0", terms: null }];
    const mcp = new SealedOrdersMcp(agent, VAULT, "desk", dir);
    const file = { order: terms, vault: VAULT, role: "desk", id: 0, sealedAccountId: "sealed.testnet", commitment: "0x00" };
    const adopted = await mcp.adopt({ orderFile: JSON.stringify(file) });
    expect(adopted.id).toBe(9);
    expect(JSON.parse(readFileSync(adopted.orderFile, "utf8")).commitment).toBe(commitment);
    await expect(mcp.adopt({ orderFile: JSON.stringify({ ...file, vault: "other.testnet" }) })).rejects.toThrow(/not this company/);
    await expect(mcp.adopt({ orderFile: JSON.stringify({ ...file, order: { ...terms, cap: "1" } }) })).rejects.toThrow(/no order of this company/);
  });
});
