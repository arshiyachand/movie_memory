import { prisma } from "@/lib/prisma";
import { generateMovieFact } from "@/lib/openai";
import { logger, errorFields } from "@/lib/logger";
import { normalizeMovieTitle } from "@/lib/validation";

// A stored fact is served straight from cache if it's younger than this.
export const CACHE_WINDOW_MS = 60_000;

// A generationStartedAt timestamp older than this is treated as abandoned
// (e.g. the instance that set it crashed mid-call) and future requests are
// allowed to retry instead of being blocked forever.
export const LOCK_STALE_MS = 15_000;

// Only the latest N facts per user are kept, so the table can't grow forever.
// The cache and dashboard only ever need the newest one.
export const FACT_RETENTION = 20;

// Slack for the work after OpenAI returns (insert Fact, clear lock) and for
// clock differences between instances.
const LOCK_SAFETY_MARGIN_MS = 5_000;

// Total time OpenAI generation (all retries included) may take. Derived from
// LOCK_STALE_MS so it is always shorter than it: if generation could outlive
// the lock, a second request would consider the lock abandoned, take it, and
// make a duplicate OpenAI call while the first is still running.
export const GENERATION_BUDGET_MS = LOCK_STALE_MS - LOCK_SAFETY_MARGIN_MS;

export type FactRecord = { content: string; createdAt: Date };

export type FactResult =
  | { status: "fresh"; fact: FactRecord }
  | { status: "generated"; fact: FactRecord }
  | { status: "in_progress"; fact: FactRecord | null }
  | { status: "no_movie" }
  | { status: "error"; message: string; fact: FactRecord | null };

/**
 * Returns a fun fact for the given user's favorite movie, using a 60-second
 * cache and a Postgres-backed generation lock to avoid duplicate/overlapping
 * OpenAI calls. See README "Architecture" section for the full design
 * rationale (why this is a DB flag and not an in-memory lock).
 */
export async function getOrGenerateFact(userId: string): Promise<FactResult> {
  const startedAt = Date.now();
  const log = (event: string, extra: Record<string, unknown> = {}) =>
    logger.info({ event, userId, durationMs: Date.now() - startedAt, ...extra });

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { favoriteMovie: true },
  });

  if (!user.favoriteMovie) {
    return { status: "no_movie" };
  }
  const movie = normalizeMovieTitle(user.favoriteMovie);

  // Only facts about the *current* favorite movie count, both for the cache
  // and for the fallback on failure, so editing the movie can never surface a
  // fact about the wrong film.
  let latestFact = await getLatestFact(userId, movie);
  if (latestFact && isFresh(latestFact)) {
    log("cache_hit", { source: "initial" });
    return { status: "fresh", fact: latestFact };
  }

  // Try to atomically acquire the generation lock: this UPDATE only affects
  // a row whose lock is unset or stale. Postgres serializes concurrent
  // UPDATEs to the same row, so exactly one concurrent caller can "win" this
  // — the loser's WHERE clause re-evaluates against the winner's committed
  // write and no longer matches. That single conditional UPDATE is what
  // makes this safe across multiple server instances without app-level
  // locking.
  const lockedAt = new Date();
  const staleBefore = new Date(lockedAt.getTime() - LOCK_STALE_MS);
  const { count } = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ generationStartedAt: null }, { generationStartedAt: { lt: staleBefore } }],
    },
    data: { generationStartedAt: lockedAt },
  });

  if (count === 0) {
    // Someone else (another request, another instance) is already
    // generating. Don't call OpenAI again — hand back whatever we have.
    log("lock_contended");
    return { status: "in_progress", fact: latestFact };
  }

  log("lock_acquired");

  try {
    // Re-check now that we hold the lock. Another request may have finished
    // generating (and released the lock) between our first read and our
    // acquiring it; without this we'd produce a second fact inside the same
    // 60s window.
    latestFact = await getLatestFact(userId, movie);
    if (latestFact && isFresh(latestFact)) {
      log("cache_hit", { source: "after_lock" });
      return { status: "fresh", fact: latestFact };
    }

    const content = await generateMovieFact(movie, GENERATION_BUDGET_MS);

    // The user may have edited their movie while OpenAI was working. Don't
    // store or return a fact about the old film.
    if (await movieChanged(userId, movie)) {
      log("movie_changed_during_generation");
      return { status: "in_progress", fact: null };
    }

    const fact = await prisma.fact.create({
      data: { userId, content, movie },
      select: { content: true, createdAt: true },
    });
    log("fact_generated");
    await pruneOldFacts(userId);
    return { status: "generated", fact };
  } catch (err) {
    logger.error(
      { event: "openai_error", userId, durationMs: Date.now() - startedAt, ...errorFields(err) },
      "fact generation failed",
    );
    // Fall back to the last known fact (if any) rather than failing outright.
    return {
      status: "error",
      message: "We couldn't generate a new fact right now. Please try again in a moment.",
      fact: latestFact,
    };
  } finally {
    await releaseLock(userId, lockedAt);
  }
}

export type FactPeek = { fact: FactRecord | null; generating: boolean };

/**
 * Side-effect-free read for polling: the latest fact for the user's current
 * movie, and whether a generation is in flight (a lock younger than
 * LOCK_STALE_MS). Never generates and never touches the lock, so clients can
 * call it as often as they like.
 */
export async function peekFact(userId: string): Promise<FactPeek> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { favoriteMovie: true, generationStartedAt: true },
  });

  const generating =
    user.generationStartedAt !== null &&
    Date.now() - user.generationStartedAt.getTime() < LOCK_STALE_MS;

  const fact = user.favoriteMovie
    ? await getLatestFact(userId, normalizeMovieTitle(user.favoriteMovie))
    : null;

  return { fact, generating };
}

function isFresh(fact: FactRecord): boolean {
  return Date.now() - fact.createdAt.getTime() < CACHE_WINDOW_MS;
}

/** Latest fact for this user about this movie (case-insensitive match). */
export function getLatestFact(userId: string, movie: string): Promise<FactRecord | null> {
  return prisma.fact.findFirst({
    where: { userId, movie: { equals: movie, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
    select: { content: true, createdAt: true },
  });
}

/**
 * Best-effort retention: delete everything beyond the newest FACT_RETENTION
 * facts. Failure is logged and ignored; the next generation tries again.
 */
async function pruneOldFacts(userId: string): Promise<void> {
  try {
    const stale = await prisma.fact.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: FACT_RETENTION,
      select: { id: true },
    });
    if (stale.length > 0) {
      await prisma.fact.deleteMany({ where: { id: { in: stale.map((f) => f.id) } } });
    }
  } catch (err) {
    logger.warn({ event: "fact_prune_failed", userId, ...errorFields(err) }, "could not prune old facts");
  }
}

async function movieChanged(userId: string, movie: string): Promise<boolean> {
  const current = await prisma.user.findUnique({
    where: { id: userId },
    select: { favoriteMovie: true },
  });
  const now = current?.favoriteMovie ? normalizeMovieTitle(current.favoriteMovie) : null;
  return now?.toLowerCase() !== movie.toLowerCase();
}

/**
 * Releases the lock only if it is still the one *we* set (matched by its
 * exact timestamp). If our generation outlived the stale window and another
 * request took the lock over, this is a no-op instead of wiping their lock.
 * A failed release is swallowed: it must not turn a saved fact into a 500,
 * and the stale-lock timeout recovers on its own.
 */
async function releaseLock(userId: string, lockedAt: Date): Promise<void> {
  try {
    await prisma.user.updateMany({
      where: { id: userId, generationStartedAt: lockedAt },
      data: { generationStartedAt: null },
    });
  } catch (err) {
    logger.warn({ event: "lock_release_failed", userId, ...errorFields(err) }, "could not release lock");
  }
}
