import { assertIsTestDatabase } from "./testDb";

// Runs in every integration test worker before any test file imports Prisma.
// Belt and braces: even if the config were changed, never talk to a database
// that isn't clearly a test database.
assertIsTestDatabase(process.env.DATABASE_URL ?? "");
