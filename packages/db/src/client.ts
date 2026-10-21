import { PrismaClient } from "@prisma/client";

export { PrismaClient } from "@prisma/client";
export type { Prisma } from "@prisma/client";

const globalPrisma = globalThis as typeof globalThis & { mandateosPrisma?: PrismaClient };

export const prisma = globalPrisma.mandateosPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalPrisma.mandateosPrisma = prisma;
}
