// Shared by the integration test config, its global setup and the tests.

// Matches docker-compose.yml. CI (or anyone with their own Postgres) sets
// TEST_DATABASE_URL instead.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/movie_memory_test";

/**
 * Integration tests write to and delete from the database. Refuse to run
 * against anything that doesn't look like a dedicated test database, so a
 * misconfigured URL can never wipe real data.
 */
export function assertIsTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to run integration tests against database "${name}": ` +
        `its name must contain "test". Set TEST_DATABASE_URL to a dedicated test database.`,
    );
  }
}
