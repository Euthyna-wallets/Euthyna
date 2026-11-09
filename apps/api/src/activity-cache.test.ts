/**
 * The Activity page is refreshed every few seconds: a euro payout whose record can no longer
 * change (refused, or its transfer queued) is read from the vault once, not on every refresh.
 */
import type { PrismaClient } from "@euthyna/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { OmniRolesService, type OmniRolesConfig } from "./omniroles.js";

const VAULT = "acme.nomos.testnet";
const opHex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const payout = (n: number, state: string) => ({
  op_id: Array.from(Buffer.from(opHex(n).slice(2), "hex")),
  member: "agent.testnet",
  role: "payer",
  beneficiary_id: 1,
  beneficiary_label: "Supplier A",
  commitment: "c",
  amount: "1000000",
  reference: `ref-${n}`,
  state,
  created_at_ns: "1",
  expires_at_ns: "2",
  rule_id: null,
  deposit_address: null,
  fiat_amount: null,
  transfer_op_id: null,
  error: state === "Failed" ? "refused" : null,
});

afterEach(() => vi.unstubAllGlobals());

describe("activity", () => {
  it("reads a settled payout once, and keeps reading one still waiting for the enclave", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("index down"); }));
    const states: Record<string, string> = { [opHex(1)]: "Failed", [opHex(2)]: "Pending" };
    const payoutReads: string[] = [];
    const near = {
      viewFunction: vi.fn(async (_account: string, method: string, args: { op_id?: number[] }) => {
        if (method === "get_bank_payout") {
          const opId = `0x${Buffer.from(args.op_id!).toString("hex")}`;
          payoutReads.push(opId);
          return payout(Number.parseInt(opId.slice(2), 16), states[opId]!);
        }
        return null;
      }),
    } as unknown as NearClient;
    const prisma = {
      treasury: { findUnique: async () => ({ organizationId: "org", vaultAccountId: VAULT, daoAccountId: "dao.testnet", baseChainId: 84532 }) },
      operation: { findMany: async () => [] },
      auditLog: { findMany: async () => [] },
      agent: { findMany: async () => [] },
      supplierWallet: { findMany: async () => [] },
      vaultTxRead: { findMany: async () => [] },
      vaultOperationLog: {
        findMany: async () => [1, 2].map((n) => ({ kind: "bank", opId: opHex(n), txHash: `tx-${n}`, at: new Date(Date.UTC(2026, 10, 1, 10, n)) })),
      },
    } as unknown as PrismaClient;
    const service = new OmniRolesService(prisma, near, {} as KmsSigner, {} as KmsSigner, { proposalBondYocto: "1", proposalPeriodNs: "1", txIndexerUrl: "https://index.invalid" } as OmniRolesConfig);

    await service.activity("org");
    expect(payoutReads.sort()).toEqual([opHex(1), opHex(2)]);

    payoutReads.length = 0;
    await service.activity("org");
    expect(payoutReads).toEqual([opHex(2)]); // the refused payout is not read again
  });

  it("keeps at most two reads in flight, so a sign-in never waits behind the whole page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("index down"); }));
    let inFlight = 0; let peak = 0;
    const near = {
      viewFunction: vi.fn(async (_account: string, method: string, args: { op_id?: number[] }) => {
        if (method !== "get_bank_payout") return null;
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return payout(Number.parseInt(Buffer.from(args.op_id!).toString("hex"), 16), "Pending");
      }),
    } as unknown as NearClient;
    const prisma = {
      treasury: { findUnique: async () => ({ organizationId: "org", vaultAccountId: VAULT, daoAccountId: "dao.testnet", baseChainId: 84532 }) },
      operation: { findMany: async () => [] },
      auditLog: { findMany: async () => [] },
      agent: { findMany: async () => [] },
      supplierWallet: { findMany: async () => [] },
      vaultTxRead: { findMany: async () => [] },
      vaultOperationLog: { findMany: async () => Array.from({ length: 30 }, (_, n) => ({ kind: "bank", opId: opHex(n + 1), txHash: `tx-${n}`, at: new Date(Date.UTC(2026, 10, 1, 10, n)) })) },
    } as unknown as PrismaClient;
    const service = new OmniRolesService(prisma, near, {} as KmsSigner, {} as KmsSigner, { proposalBondYocto: "1", proposalPeriodNs: "1", txIndexerUrl: "https://index.invalid" } as OmniRolesConfig);
    await service.activity("org");
    expect(peak).toBe(2);
  });
});
