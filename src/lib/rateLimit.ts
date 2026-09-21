import { prisma } from "@/lib/prisma";
import { logger, errorFields } from "@/lib/logger";

export type RateLimitResult = {
  allowed: boolean;
  /** Requests left in the current window (0 when over the limit). */
  remaining: number;
  /** Whole seconds until the window resets; use for the Retry-After header. */
  retryAfterSeconds: number;
};

// Chance per call of also purging expired rows, so the table doesn't grow
// forever without needing a separate cleanup job.
const PURGE_PROBABILITY = 0.01;

/**
 * Fixed-window rate limiter backed by Postgres: allows at most `limit` calls
 * per `key` per `windowMs`.
 *
 * Each (key, window) is one row, bumped with a single atomic
 * `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count` —
 * the same trick as the generation lock: the database serializes concurrent
 * increments, so the count is exact across any number of server instances
 * and there is no read-then-write race.
 *
 * Why not in-memory: it only counts what one process sees, so N instances
 * would allow N times the limit. Why not Redis: it would scale better, but
 * it makes the project harder to run. This function is the only seam — to
 * move to Redis, reimplement this one function (INCR + EXPIRE) and nothing
 * else changes.
 *
 * Fails open: if the limiter's own database call fails, the request is
 * allowed (and logged). The app needs that same database to do anything
 * useful anyway, so blocking everyone on a limiter hiccup adds no safety.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const window = Math.floor(now / windowMs);
  const windowEnd = (window + 1) * windowMs;
  const bucketKey = `${key}:${window}`;

  let count: number;
  try {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "RateLimit" ("key", "count", "expiresAt")
      VALUES (${bucketKey}, 1, ${new Date(windowEnd)})
      ON CONFLICT ("key") DO UPDATE SET "count" = "RateLimit"."count" + 1
      RETURNING "count"`;
    count = Number(rows[0].count);
  } catch (err) {
    logger.warn({ event: "rate_limit_error", ...errorFields(err) }, "rate limiter failed; allowing request");
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }

  // Housekeeping in its own try so a purge failure can never change the
  // decision above.
  if (Math.random() < PURGE_PROBABILITY) {
    try {
      await prisma.rateLimit.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
    } catch (err) {
      logger.warn({ event: "rate_limit_purge_error", ...errorFields(err) }, "could not purge expired rate limit rows");
    }
  }

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)),
  };
}
