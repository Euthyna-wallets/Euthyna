import { describe, expect, it } from "vitest";
import { OmniRolesService } from "./omniroles.js";

type Seat = { id: string; organizationId: string; userId: string; role: string; nearAccountId: string | null; createdAt: Date };

/** The tables syncSeats touches, in memory. */
function world(seats: Array<Pick<Seat, "role" | "nearAccountId">>) {
  let next = 0;
  const members: Seat[] = seats.map((seat, index) => ({ id: `m${index}`, organizationId: "org", userId: `u-${seat.nearAccountId}`, createdAt: new Date(1_000 + index), ...seat }));
  const accounts: Array<{ userId: string; accountId: string }> = members.map((seat) => ({ userId: seat.userId, accountId: seat.nearAccountId! }));
  const users: Array<{ id: string; email: string }> = members.map((seat) => ({ id: seat.userId, email: `${seat.nearAccountId}@near` }));
  const match = (seat: Seat, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => {
    if (key === "nearAccountId" && value && typeof value === "object" && "in" in value) return (value.in as string[]).includes(seat.nearAccountId ?? "");
    return (seat as unknown as Record<string, unknown>)[key] === value;
  });
  const sorted = (list: Seat[]) => [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const prisma = {
    member: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => sorted(members.filter((seat) => match(seat, where))),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => members.find((seat) => match(seat, where)) ?? null,
      create: async ({ data }: { data: Seat }) => { members.push({ ...data, createdAt: new Date(5_000 + next++) }); return data; },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Seat> }) => Object.assign(members.find((seat) => seat.id === where.id)!, data),
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => { for (const id of where.id.in) members.splice(members.findIndex((seat) => seat.id === id), 1); },
    },
    account: {
      findFirst: async ({ where }: { where: { accountId: string } }) => accounts.find((account) => account.accountId === where.accountId) ?? null,
      create: async ({ data }: { data: { userId: string; accountId: string } }) => { accounts.push(data); return data; },
    },
    user: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => users.find((user) => user.id === where.id)!,
      findUnique: async ({ where }: { where: { email: string } }) => users.find((user) => user.email === where.email) ?? null,
      create: async ({ data }: { data: { id: string; email: string } }) => { users.push(data); return data; },
    },
  };
  const service = new OmniRolesService(prisma as never, {} as never, {} as never, {} as never, { proposalBondYocto: "1", proposalPeriodNs: "1" } as never);
  const sync = (dao: string[]) => (service as unknown as { syncSeats(org: string, dao: string[]): Promise<void> }).syncSeats("org", dao);
  const roles = () => Object.fromEntries(members.map((seat) => [seat.nearAccountId, seat.role]));
  return { sync, roles };
}

describe("console seats follow the DAO, the owner's too", () => {
  it("a recovered owner's seat goes, and the account that replaced it in the DAO becomes the owner", async () => {
    const { sync, roles } = world([{ role: "owner", nearAccountId: "a.testnet" }, { role: "member", nearAccountId: "b.testnet" }, { role: "member", nearAccountId: "c.testnet" }]);
    await sync(["b.testnet", "c.testnet", "e.testnet"]);
    expect(roles()).toEqual({ "b.testnet": "member", "c.testnet": "member", "e.testnet": "owner" });
  });

  it("an owner voted out without a replacement hands the company to the longest-standing founder", async () => {
    const { sync, roles } = world([{ role: "owner", nearAccountId: "a.testnet" }, { role: "member", nearAccountId: "b.testnet" }, { role: "member", nearAccountId: "c.testnet" }]);
    await sync(["b.testnet", "c.testnet"]);
    expect(roles()).toEqual({ "b.testnet": "owner", "c.testnet": "member" });
  });

  it("changes nothing for an owner still in the DAO, and removes other members who left", async () => {
    const { sync, roles } = world([{ role: "owner", nearAccountId: "a.testnet" }, { role: "member", nearAccountId: "b.testnet" }, { role: "member", nearAccountId: "c.testnet" }]);
    await sync(["a.testnet", "b.testnet", "d.testnet"]);
    expect(roles()).toEqual({ "a.testnet": "owner", "b.testnet": "member", "d.testnet": "member" });
  });

  it("never empties the company when the DAO read has no members", async () => {
    const { sync, roles } = world([{ role: "owner", nearAccountId: "a.testnet" }]);
    await sync([]);
    expect(roles()).toEqual({ "a.testnet": "owner" });
  });
});
