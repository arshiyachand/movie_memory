import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Prisma client and the OpenAI wrapper so tests exercise only the
// caching / locking / fallback logic in factService, with no real DB or API
// calls.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    fact: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/openai", () => ({
  generateMovieFact: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { generateMovieFact } from "@/lib/openai";
import {
  getOrGenerateFact,
  CACHE_WINDOW_MS,
  LOCK_STALE_MS,
  GENERATION_BUDGET_MS,
} from "@/lib/factService";

const mockPrisma = vi.mocked(prisma, true);
const mockGenerateMovieFact = vi.mocked(generateMovieFact);

const USER_ID = "user-1";

function mockUser(favoriteMovie: string | null = "The Matrix") {
  mockPrisma.user.findUniqueOrThrow.mockResolvedValue({ favoriteMovie } as never);
}


// The release must be scoped to the exact timestamp this request set, so it
// can never wipe a lock that another request has since taken over.
function expectLockReleasedByOwner() {
  expect(mockPrisma.user.updateMany).toHaveBeenLastCalledWith({
    where: { id: USER_ID, generationStartedAt: expect.any(Date) },
    data: { generationStartedAt: null },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getOrGenerateFact — 60s cache window", () => {
  it("returns the stored fact without calling OpenAI when it is fresh (<60s old)", async () => {
    mockUser();
    mockPrisma.fact.findFirst.mockResolvedValue({
      content: "cached fact",
      createdAt: new Date(Date.now() - 5_000), // 5s old
    } as never);

    const result = await getOrGenerateFact(USER_ID);

    expect(result).toEqual({
      status: "fresh",
      fact: { content: "cached fact", createdAt: expect.any(Date) },
    });
    expect(mockGenerateMovieFact).not.toHaveBeenCalled();
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("generates a new fact when the stored one is stale (>60s old)", async () => {
    mockUser();
    mockPrisma.fact.findFirst.mockResolvedValue({
      content: "old fact",
      createdAt: new Date(Date.now() - (CACHE_WINDOW_MS + 1_000)),
    } as never);
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 } as never);
    mockGenerateMovieFact.mockResolvedValue("brand new fact");
    mockPrisma.fact.create.mockResolvedValue({
      content: "brand new fact",
      createdAt: new Date(),
    } as never);

    const result = await getOrGenerateFact(USER_ID);

    expect(mockGenerateMovieFact).toHaveBeenCalledWith("The Matrix", GENERATION_BUDGET_MS);
    expect(result.status).toBe("generated");
    expectLockReleasedByOwner();
  });

  it("generates a new fact when none exists yet", async () => {
    mockUser();
    mockPrisma.fact.findFirst.mockResolvedValue(null);
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 } as never);
    mockGenerateMovieFact.mockResolvedValue("first fact");
    mockPrisma.fact.create.mockResolvedValue({
      content: "first fact",
      createdAt: new Date(),
    } as never);

    const result = await getOrGenerateFact(USER_ID);

    expect(result.status).toBe("generated");
    expect(mockGenerateMovieFact).toHaveBeenCalledOnce();
  });
});

describe("getOrGenerateFact — generation-in-progress guard", () => {
  it("does not call OpenAI when the DB lock update affects 0 rows (already in progress)", async () => {
    mockUser();
    mockPrisma.fact.findFirst.mockResolvedValue({
      content: "last known fact",
      createdAt: new Date(Date.now() - (CACHE_WINDOW_MS + 1_000)),
    } as never);
    // Simulate another request already holding the lock: the conditional
    // UPDATE matches 0 rows.
    mockPrisma.user.updateMany.mockResolvedValue({ count: 0 } as never);

    const result = await getOrGenerateFact(USER_ID);

    expect(mockGenerateMovieFact).not.toHaveBeenCalled();
    // We never held the lock, so there is nothing of ours to release.
    expect(mockPrisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "in_progress",
      fact: { content: "last known fact", createdAt: expect.any(Date) },
    });
  });

  it("attempts the atomic lock UPDATE scoped to null-or-stale generationStartedAt", async () => {
    mockUser();
    mockPrisma.fact.findFirst.mockResolvedValue(null);
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 } as never);
    mockGenerateMovieFact.mockResolvedValue("fact");
    mockPrisma.fact.create.mockResolvedValue({ content: "fact", createdAt: new Date() } as never);

    await getOrGenerateFact(USER_ID);

    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        OR: [{ generationStartedAt: null }, { generationStartedAt: { lt: expect.any(Date) } }],
      },
      data: { generationStartedAt: expect.any(Date) },
    });
  });
});

describe("generation budget vs. lock staleness", () => {
  it("keeps the total OpenAI budget strictly shorter than the stale-lock window", () => {
    // If generation (retries included) could outlive the lock, a second
    // request could take the lock over mid-flight and duplicate the call.
    expect(GENERATION_BUDGET_MS).toBeLessThan(LOCK_STALE_MS);
  });
});

describe("getOrGenerateFact — lock correctness", () => {
  it("skips OpenAI when a fresh fact appeared between the first read and winning the lock", async () => {
    mockUser();
    const fresh = { content: "just generated by someone else", createdAt: new Date() };
    // First read sees nothing/stale; by the time we hold the lock, another
    // request has finished and stored a fresh fact.
    mockPrisma.fact.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fresh as never);
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await getOrGenerateFact(USER_ID);

    expect(result).toEqual({ status: "fresh", fact: fresh });
    expect(mockGenerateMovieFact).not.toHaveBeenCalled();
    expect(mockPrisma.fact.create).not.toHaveBeenCalled();
    expectLockReleasedByOwner();
  });

  it("still returns the saved fact if releasing the lock fails", async () => {
    mockUser();
    mockPrisma.fact.findFirst.mockResolvedValue(null);
    mockPrisma.user.updateMany
      .mockResolvedValueOnce({ count: 1 } as never) // acquire
      .mockRejectedValueOnce(new Error("db hiccup")); // release
    mockGenerateMovieFact.mockResolvedValue("fact");
    mockPrisma.fact.create.mockResolvedValue({ content: "fact", createdAt: new Date() } as never);

    const result = await getOrGenerateFact(USER_ID);

    expect(result.status).toBe("generated");
  });
});

describe("getOrGenerateFact — failure handling", () => {
  it("clears the lock and falls back to the last cached fact when OpenAI fails", async () => {
    mockUser();
    const staleFact = {
      content: "old but usable",
      createdAt: new Date(Date.now() - (CACHE_WINDOW_MS + 1_000)),
    };
    mockPrisma.fact.findFirst.mockResolvedValue(staleFact as never);
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 } as never);
    mockGenerateMovieFact.mockRejectedValue(new Error("OpenAI timeout"));

    const result = await getOrGenerateFact(USER_ID);

    expect(result.status).toBe("error");
    expect(result).toMatchObject({ fact: { content: "old but usable" } });
    expectLockReleasedByOwner();
  });

  it("returns a clean error with no fact when OpenAI fails and nothing is cached", async () => {
    mockUser();
    mockPrisma.fact.findFirst.mockResolvedValue(null);
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 } as never);
    mockGenerateMovieFact.mockRejectedValue(new Error("OpenAI timeout"));

    const result = await getOrGenerateFact(USER_ID);

    expect(result).toEqual({
      status: "error",
      fact: null,
      message: expect.stringContaining("try again"),
    });
  });
});
