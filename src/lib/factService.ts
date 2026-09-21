import { prisma } from "@/lib/prisma";
import { generateMovieFact } from "@/lib/openai";

// A stored fact is served straight from cache if it's younger than this.
export const CACHE_WINDOW_MS = 60_000;

// A generationStartedAt timestamp older than this is treated as abandoned
// (e.g. the instance that set it crashed mid-call) and future requests are
// allowed to retry instead of being blocked forever.
export const LOCK_STALE_MS = 15_000;

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
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { favoriteMovie: true },
  });

  if (!user.favoriteMovie) {
    return { status: "no_movie" };
  }

  const latestFact = await latestFactFor(userId);
  if (latestFact && Date.now() - latestFact.createdAt.getTime() < CACHE_WINDOW_MS) {
    return { status: "fresh", fact: latestFact };
  }

  // Try to atomically acquire the generation lock: this UPDATE only affects
  // a row whose lock is unset or stale. Postgres serializes concurrent
  // UPDATEs to the same row, so exactly one concurrent caller can "win" this
  // — the loser's WHERE clause re-evaluates against the winner's committed
  // write and no longer matches. That single conditional UPDATE is what
  // makes this safe across multiple server instances without app-level
  // locking.
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS);
  const { count } = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ generationStartedAt: null }, { generationStartedAt: { lt: staleBefore } }],
    },
    data: { generationStartedAt: new Date() },
  });

  if (count === 0) {
    // Someone else (another request, another instance) is already
    // generating. Don't call OpenAI again — hand back whatever we have.
    return { status: "in_progress", fact: latestFact };
  }

  try {
    const content = await generateMovieFact(user.favoriteMovie, GENERATION_BUDGET_MS);
    const fact = await prisma.fact.create({
      data: { userId, content },
      select: { content: true, createdAt: true },
    });
    await clearLock(userId);
    return { status: "generated", fact };
  } catch (err) {
    await clearLock(userId);
    const message =
      "We couldn't generate a new fact right now. Please try again in a moment.";
    if (latestFact) {
      // Fall back to the last known fact rather than failing the request.
      return { status: "error", message, fact: latestFact };
    }
    return { status: "error", message, fact: null };
  }
}

function latestFactFor(userId: string): Promise<FactRecord | null> {
  return prisma.fact.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { content: true, createdAt: true },
  });
}

function clearLock(userId: string) {
  return prisma.user.update({
    where: { id: userId },
    data: { generationStartedAt: null },
  });
}
