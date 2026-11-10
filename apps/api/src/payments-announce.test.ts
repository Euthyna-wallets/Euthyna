import { describe, expect, it } from "vitest";
import { PaymentService } from "./payments.js";

const opId = Array<number>(32).fill(0x11);
const agent = { nearAccountId: "agent.testnet", vaultAccountId: "vault.testnet" };

function fixture(operation: Record<string, unknown>, existing = false, sealed: string | null = null) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    operation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (existing) throw Object.assign(new Error("unique"), { code: "P2002" });
        created.push(data);
        return data;
      },
    },
  };
  const near = { getOperation: async () => operation };
  const service = new PaymentService(prisma as never, near as never, {} as never, {} as never, {} as never, sealed);
  return { service, created };
}

const signed = {
  member: "agent.testnet",
  state: "PossiblySigned",
  tx_digest: Array<number>(32).fill(0xab),
  evm_nonce: 7,
  request: { reference: "SWAP-1", allowance_amount: "200000" },
};

describe("an agent announces an operation it signed on chain without the Guard", () => {
  it("records it, due now, so the worker relays it on its next poll", async () => {
    const { service, created } = fixture(signed);
    const before = Date.now();
    await expect(service.announce("org", agent, opId)).resolves.toEqual({ opId: `0x${"11".repeat(32)}`, recorded: true });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      organizationId: "org",
      opId: `0x${"11".repeat(32)}`,
      vaultAccountId: "vault.testnet",
      reference: "SWAP-1",
      state: "PossiblySigned",
      txDigest: `0x${"ab".repeat(32)}`,
      evmNonce: 7n,
      amount: "200000",
    });
    expect((created[0]!.nextAttemptAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("is a no-op when the operation already has a record", async () => {
    const { service } = fixture(signed, true);
    await expect(service.announce("org", agent, opId)).resolves.toMatchObject({ recorded: false });
  });

  it("refuses another member's operation", async () => {
    const { service, created } = fixture({ ...signed, member: "other.testnet" });
    await expect(service.announce("org", agent, opId)).rejects.toMatchObject({ status: 403, code: "agent_mismatch" });
    expect(created).toHaveLength(0);
  });

  it("refuses an operation the vault has not signed", async () => {
    const { service, created } = fixture({ ...signed, state: "Queued" });
    await expect(service.announce("org", agent, opId)).rejects.toMatchObject({ status: 422, code: "operation_not_signed" });
    expect(created).toHaveLength(0);
  });

  it("takes the sealed-orders contract's operations (an agent's approval or fill), not another member's", async () => {
    const viaSealed = fixture({ ...signed, member: "sealed.testnet" }, false, "sealed.testnet");
    await expect(viaSealed.service.announce("org", agent, opId)).resolves.toMatchObject({ recorded: true });
    const unknown = fixture({ ...signed, member: "sealed.testnet" });
    await expect(unknown.service.announce("org", agent, opId)).rejects.toMatchObject({ code: "agent_mismatch" });
  });
});
