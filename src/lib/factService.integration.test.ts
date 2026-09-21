import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

// Only OpenAI is faked. Prisma, Postgres, the lock and the cache are all real,
// so these tests prove the concurrency behavior instead of assuming it.
vi.mock("@/lib/openai", () => ({ generateMovieFact: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { generateMovieFact } from "@/lib/openai";
import {
  getOrGenerateFact,
  peekFact,
  CACHE_WINDOW_MS,
  FACT_RETENTION,
  LOCK_STALE_MS,
} from "@/lib/factService";

const openai = vi.mocked(generateMovieFact);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const createdUserIds: string[] = [];

async function makeUser(favoriteMovie: string | null = "The Matrix") {
  const user = await prisma.user.create({
    data: { email: `it-${randomUUID()}@test.local`, favoriteMovie },
  });
  createdUserIds.push(user.id);
  return user;
}

const factCount = (userId: string) => prisma.fact.count({ where: { userId } });
const lockOf = async (userId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).generationStartedAt;

/**
 * Opens `n` real connections up front. The pool connects lazily, so without
 * this the "simultaneous" requests below would be staggered by connection
 * setup, and early requests could finish locking before late ones even start,
 * hiding a race. Holding each connection briefly forces all `n` to be open at
 * once, so the requests genuinely collide.
 */
async function warmPool(n: number) {
  await Promise.all(
    Array.from({ length: n }, () => prisma.$queryRaw`SELECT 1 AS ok FROM pg_sleep(0.2)`),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  openai.mockReset();
});

afterEach(async () => {
  // Facts cascade with the user.
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds.splice(0) } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("concurrent generation (the lock, for real)", () => {
  it("20 simultaneous requests → OpenAI is called exactly once and exactly one Fact exists", async () => {
    const user = await makeUser();
    openai.mockImplementation(async () => {
      await sleep(300); // long enough that all 20 overlap with the generation
      return "the one and only fact";
    });
    await warmPool(20);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => getOrGenerateFact(user.id)),
    );

    expect(openai).toHaveBeenCalledTimes(1);
    expect(await factCount(user.id)).toBe(1);
    expect(results.filter((r) => r.status === "generated")).toHaveLength(1);
    expect(results.filter((r) => r.status === "error")).toHaveLength(0);
    // Everyone else was served the cache or told a generation is in flight.
    for (const r of results) {
      expect(["generated", "fresh", "in_progress"]).toContain(r.status);
    }
    expect(await lockOf(user.id)).toBeNull();
  });

  it("requests arriving throughout the generation, and right as it finishes, still produce one fact", async () => {
    // Arrivals spread over ~0.9s around a 300ms generation, so some read state
    // just before the winner stores its fact and try the lock just after it
    // is released — the window the post-lock re-check exists to close.
    const user = await makeUser();
    openai.mockImplementation(async () => {
      await sleep(300);
      return "staggered fact";
    });

    const results = await Promise.all(
      Array.from({ length: 36 }, async (_, i) => {
        await sleep(i * 25);
        return getOrGenerateFact(user.id);
      }),
    );

    expect(openai).toHaveBeenCalledTimes(1);
    expect(await factCount(user.id)).toBe(1);
    expect(results.filter((r) => r.status === "generated")).toHaveLength(1);
  });

  it("closes the read-then-lock race window: a stale first read plus a fresh fact by lock time means no OpenAI call", async () => {
    const user = await makeUser();
    await prisma.fact.create({
      data: { userId: user.id, content: "stored by a request that just finished", movie: "The Matrix" },
    });

    // This request's first read happens "before" that fact existed.
    vi.spyOn(prisma.fact, "findFirst").mockResolvedValueOnce(null);

    const result = await getOrGenerateFact(user.id);

    expect(result).toMatchObject({
      status: "fresh",
      fact: { content: "stored by a request that just finished" },
    });
    expect(openai).not.toHaveBeenCalled();
    expect(await factCount(user.id)).toBe(1);
    expect(await lockOf(user.id)).toBeNull();
  });
});

describe("lock lifecycle", () => {
  it("a fresh lock held by someone else blocks generation and is left untouched", async () => {
    const user = await makeUser();
    const held = new Date(Date.now() - 1_000);
    await prisma.user.update({ where: { id: user.id }, data: { generationStartedAt: held } });

    const result = await getOrGenerateFact(user.id);

    expect(result).toEqual({ status: "in_progress", fact: null });
    expect(openai).not.toHaveBeenCalled();
    expect((await lockOf(user.id))?.getTime()).toBe(held.getTime());
  });

  it("a stale (abandoned) lock is taken over so a crashed request can't wedge the user", async () => {
    const user = await makeUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { generationStartedAt: new Date(Date.now() - (LOCK_STALE_MS + 1_000)) },
    });
    openai.mockResolvedValue("recovered fact");

    const result = await getOrGenerateFact(user.id);

    expect(result.status).toBe("generated");
    expect(await lockOf(user.id)).toBeNull();
  });

  it("only releases its OWN lock: if another request took the lock over, it is not wiped", async () => {
    const user = await makeUser();
    const takenOverBy = new Date(Date.now() + 5_000); // a different holder's timestamp
    openai.mockImplementation(async () => {
      // While we generate, our lock is deemed stale and someone else takes it.
      await prisma.user.update({
        where: { id: user.id },
        data: { generationStartedAt: takenOverBy },
      });
      return "slow fact";
    });

    const result = await getOrGenerateFact(user.id);

    expect(result.status).toBe("generated");
    expect((await lockOf(user.id))?.getTime()).toBe(takenOverBy.getTime());
  });

  it("releases the lock when OpenAI fails", async () => {
    const user = await makeUser();
    openai.mockRejectedValue(new Error("OpenAI down"));

    const result = await getOrGenerateFact(user.id);

    expect(result).toMatchObject({ status: "error", fact: null });
    expect(await lockOf(user.id)).toBeNull();
  });
});

describe("cache window", () => {
  it("serves a fresh fact from cache, then generates a new one once it is older than 60s", async () => {
    const user = await makeUser();
    const fact = await prisma.fact.create({
      data: { userId: user.id, content: "cached", movie: "The Matrix" },
    });

    const cached = await getOrGenerateFact(user.id);
    expect(cached).toMatchObject({ status: "fresh", fact: { content: "cached" } });
    expect(openai).not.toHaveBeenCalled();

    await prisma.fact.update({
      where: { id: fact.id },
      data: { createdAt: new Date(Date.now() - (CACHE_WINDOW_MS + 5_000)) },
    });
    openai.mockResolvedValue("new fact");

    const regenerated = await getOrGenerateFact(user.id);
    expect(regenerated).toMatchObject({ status: "generated", fact: { content: "new fact" } });
    expect(openai).toHaveBeenCalledTimes(1);
  });
});

describe("editable favorite movie", () => {
  it("never serves a fact about the old movie: it is neither cached nor used as a fallback", async () => {
    const user = await makeUser("The Matrix");
    await prisma.fact.create({
      data: { userId: user.id, content: "about The Matrix", movie: "The Matrix" },
    });
    await prisma.user.update({ where: { id: user.id }, data: { favoriteMovie: "Inception" } });

    // Not fresh for Inception → must generate...
    openai.mockRejectedValueOnce(new Error("OpenAI down"));
    const failed = await getOrGenerateFact(user.id);
    // ...and when that fails, the Matrix fact must NOT be offered as a fallback.
    expect(failed).toMatchObject({ status: "error", fact: null });

    openai.mockResolvedValueOnce("about Inception");
    const ok = await getOrGenerateFact(user.id);
    expect(ok).toMatchObject({ status: "generated", fact: { content: "about Inception" } });
    expect(openai).toHaveBeenLastCalledWith("Inception", expect.any(Number));

    const stored = await prisma.fact.findFirst({
      where: { userId: user.id, content: "about Inception" },
    });
    expect(stored?.movie).toBe("Inception");
  });

  it("treats title case/spacing differences as the same movie (normalized comparison)", async () => {
    const user = await makeUser("  the   matrix ");
    await prisma.fact.create({
      data: { userId: user.id, content: "cached", movie: "The Matrix" },
    });

    const result = await getOrGenerateFact(user.id);

    expect(result).toMatchObject({ status: "fresh", fact: { content: "cached" } });
    expect(openai).not.toHaveBeenCalled();
  });

  it("discards a generation that finishes after the user changed their movie", async () => {
    const user = await makeUser("The Matrix");
    openai.mockImplementation(async () => {
      await prisma.user.update({
        where: { id: user.id },
        data: { favoriteMovie: "Inception", generationStartedAt: null },
      });
      return "a fact about The Matrix";
    });

    const result = await getOrGenerateFact(user.id);

    expect(result).toEqual({ status: "in_progress", fact: null });
    expect(await factCount(user.id)).toBe(0);
  });
});

describe("fact retention", () => {
  it("keeps only the newest FACT_RETENTION facts per user", async () => {
    const user = await makeUser();
    const old = Array.from({ length: FACT_RETENTION + 5 }, (_, i) => ({
      userId: user.id,
      content: `old ${i}`,
      movie: "The Matrix",
      createdAt: new Date(Date.now() - 10 * 60_000 - i * 1_000),
    }));
    await prisma.fact.createMany({ data: old });
    openai.mockResolvedValue("newest");

    await getOrGenerateFact(user.id);

    expect(await factCount(user.id)).toBe(FACT_RETENTION);
    const newest = await prisma.fact.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    expect(newest?.content).toBe("newest");
  });
});

describe("peekFact (polling read)", () => {
  it("reports generating for a live lock, and stops once the lock is gone or stale — without ever generating", async () => {
    const user = await makeUser();

    expect((await peekFact(user.id)).generating).toBe(false);

    await prisma.user.update({ where: { id: user.id }, data: { generationStartedAt: new Date() } });
    expect((await peekFact(user.id)).generating).toBe(true);

    await prisma.user.update({
      where: { id: user.id },
      data: { generationStartedAt: new Date(Date.now() - (LOCK_STALE_MS + 1_000)) },
    });
    expect((await peekFact(user.id)).generating).toBe(false);

    expect(openai).not.toHaveBeenCalled();
    expect(await factCount(user.id)).toBe(0);
  });
});
