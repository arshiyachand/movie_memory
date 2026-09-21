import { defineConfig } from "vitest/config";
import path from "node:path";
import { TEST_DATABASE_URL } from "./src/test/testDb";

// Integration tests: real Postgres, real Prisma, only OpenAI mocked.
// Run with `npm run test:integration` (start the DB first: `npm run db:test:up`).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["./src/test/integrationGlobalSetup.ts"],
    setupFiles: ["./src/test/integrationSetup.ts"],
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      // Enough connections for ~20 concurrent requests without queueing noise.
      DATABASE_POOL_MAX: "20",
      LOG_LEVEL: "silent",
    },
    // Files share one database, so run them one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
