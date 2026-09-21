import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma 7 moved the datasource connection URL out of schema.prisma and into
// this CLI-only config file (used by `prisma migrate` / `prisma generate`).
// PrismaClient at runtime does NOT read this file — it gets its connection
// via the @prisma/adapter-pg driver adapter instead (see src/lib/prisma.ts).
export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
