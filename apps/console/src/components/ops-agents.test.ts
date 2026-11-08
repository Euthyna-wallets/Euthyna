import { describe, expect, it } from "vitest";

import type { AgentRow } from "../api.js";
import type { RoleView } from "../omniroles-api.js";
import { withChainAgents } from "./ops.js";

const role = (name: string, members: RoleView["members"]) => ({ name, members }) as unknown as RoleView;

describe("the company's agents", () => {
  it("adds the agents voted into a role on chain, once, and leaves out humans and service contracts", () => {
    const hired = [{ id: "a1", name: "scout", nearAccountId: "scout.testnet", active: true } as AgentRow];
    const roles = [
      role("treasury-desk", [
        { member: "scout.testnet", kind: "Agent" },
        { member: "payer.testnet", kind: "Agent" },
        { member: "orders.testnet", kind: "Agent", service: "sealed orders" },
        { member: "alice.testnet", kind: "Human" },
      ]),
      role("desk-two", [{ member: "payer.testnet", kind: "Agent" }]),
    ];
    const agents = withChainAgents(hired, roles);
    expect(agents.map((agent) => agent.nearAccountId)).toEqual(["scout.testnet", "payer.testnet"]);
    expect(agents[1]).toMatchObject({ name: "payer", role: "treasury-desk", active: true });
  });
});
