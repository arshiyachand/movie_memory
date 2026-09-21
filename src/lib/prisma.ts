import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prevent creating a new PrismaClient (and a new connection pool) on every
// hot-reload in dev. In production each serverless/server instance gets its
// own client, which is expected and fine — the DB itself is the shared state.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Prisma 7 has no built-in query engine binary; PrismaClient needs an
// explicit driver adapter to connect. DATABASE_URL is only read here, at
// runtime — prisma.config.ts (a separate, CLI-only file) is what
// `prisma migrate`/`prisma generate` use.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
