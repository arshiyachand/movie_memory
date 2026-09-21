import type { PoolConfig } from "pg";

// Each server instance opens its own pool, so the database sees
// (instances x max) connections. Postgres defaults to ~100 max_connections,
// which a horizontally scaled deployment can exhaust quickly — so the
// per-instance default is deliberately small.
export const DEFAULT_POOL_MAX = 5;

/**
 * Explicit connection-pool settings for the pg driver adapter.
 *
 * Tune with DATABASE_POOL_MAX. Past a handful of instances, put a pooler in
 * front of Postgres (PgBouncer, or your host's pooled connection string such
 * as Supabase/Neon's pooler) and point DATABASE_URL at it, rather than
 * raising this number: the pooler multiplexes many app connections onto few
 * real ones.
 */
export function poolConfig(env: Record<string, string | undefined> = process.env): PoolConfig {
  const parsed = Number.parseInt(env.DATABASE_POOL_MAX ?? "", 10);
  const max = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POOL_MAX;

  return {
    connectionString: env.DATABASE_URL,
    max,
    // Fail fast instead of queueing forever when the pool is exhausted.
    connectionTimeoutMillis: 5_000,
    // Return idle connections so quiet instances don't hold them.
    idleTimeoutMillis: 30_000,
  };
}
