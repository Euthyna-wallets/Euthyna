import { PrismaClient } from "@prisma/client";

const globalPrisma = globalThis as typeof globalThis & { mandateosPrisma?: PrismaClient };

export const prisma = globalPrisma.mandateosPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalPrisma.mandateosPrisma = prisma;
}
