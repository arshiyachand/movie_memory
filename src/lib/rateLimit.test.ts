import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    rateLimit: { deleteMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";

const mockPrisma = vi.mocked(prisma, true);

const WINDOW_MS = 60_000;
// 30s into a window that started at t = 1_000_000 * WINDOW_MS.
const WINDOW_START = 1_000_000 * WINDOW_MS;
const NOW = WINDOW_START + 30_000;

function countIs(n: number) {
  mockPrisma.$queryRaw.mockResolvedValue([{ count: n }] as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(Math, "random").mockReturnValue(0.5); // never purge unless a test says so
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("rateLimit", () => {
  it("allows calls up to and including the limit", async () => {
    countIs(1);
    expect(await rateLimit("k", 3, WINDOW_MS)).toMatchObject({ allowed: true, remaining: 2 });
    countIs(3);
    expect(await rateLimit("k", 3, WINDOW_MS)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("blocks once the count passes the limit and reports when to retry", async () => {
    countIs(4);

    const result = await rateLimit("k", 3, WINDOW_MS);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    // 30s left in the window.
    expect(result.retryAfterSeconds).toBe(30);
  });

  it("uses one atomic upsert whose key includes the window, expiring at the window end", async () => {
    countIs(1);

    await rateLimit("fact:user-1", 3, WINDOW_MS);

    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = mockPrisma.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    expect(sql).toMatch(/INSERT INTO "RateLimit"/);
    expect(sql).toMatch(/ON CONFLICT \("key"\) DO UPDATE SET "count" = "RateLimit"\."count" \+ 1/);
    expect(sql).toMatch(/RETURNING "count"/);
    expect(values[0]).toBe(`fact:user-1:${WINDOW_START / WINDOW_MS}`);
    expect(values[1]).toEqual(new Date(WINDOW_START + WINDOW_MS));
  });

  it("starts a fresh count in the next window", async () => {
    countIs(1);
    await rateLimit("k", 3, WINDOW_MS);
    vi.setSystemTime(WINDOW_START + WINDOW_MS + 1);
    await rateLimit("k", 3, WINDOW_MS);

    const keyOf = (i: number) =>
      (mockPrisma.$queryRaw.mock.calls[i] as unknown as unknown[])[1];
    expect(keyOf(0)).not.toBe(keyOf(1));
  });

  it("fails open when the database call errors", async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error("db down"));

    expect(await rateLimit("k", 3, WINDOW_MS)).toMatchObject({ allowed: true });
  });

  it("purges expired rows occasionally, and a purge failure never changes the decision", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // trigger the purge
    countIs(4); // over the limit
    mockPrisma.rateLimit.deleteMany.mockRejectedValue(new Error("purge failed"));

    const result = await rateLimit("k", 3, WINDOW_MS);

    expect(mockPrisma.rateLimit.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: new Date(NOW) } },
    });
    expect(result.allowed).toBe(false);
  });
});
