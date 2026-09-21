import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { Client } from "pg";
import { TEST_DATABASE_URL, assertIsTestDatabase } from "./testDb";

const require = createRequire(import.meta.url);

/** Creates the test database if the server is reachable but it doesn't exist yet. */
async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = target.pathname.replace(/^\//, "");

  const admin = new URL(url);
  admin.pathname = "/postgres";

  const client = new Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach Postgres at ${target.host}. Start the test database with ` +
        `"npm run db:test:up" (or set TEST_DATABASE_URL). Cause: ${(err as Error).message}`,
    );
  }

  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (!rowCount) {
      // Identifier can't be parameterized; dbName has been checked to contain "test"
      // and is quoted, with quotes escaped.
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }
}

/** Runs once before all integration tests: ensure the DB exists and apply the real migrations. */
export async function setup(): Promise<void> {
  assertIsTestDatabase(TEST_DATABASE_URL);
  await ensureDatabase(TEST_DATABASE_URL);

  // Uses the same migrations the app ships, so the tests exercise the real
  // schema. Runs the Prisma CLI through the current Node binary instead of
  // `npx`, which can take a minute just to resolve on slow filesystems.
  const prismaCli = require.resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
