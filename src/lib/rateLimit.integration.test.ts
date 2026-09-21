import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";

const WINDOW_MS = 60_000;
// Pin the clock to the middle of a window so a test can never straddle a
// window boundary. Only Date is faked; real timers keep database I/O working.
const MID_WINDOW = 1_000_000 * WINDOW_MS + 30_000;

let keys: string[] = [];
const newKey = () => {
  const k = `it:${randomUUID()}`;
  keys.push(k);
  return k;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MID_WINDOW);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await prisma.rateLimit.deleteMany({
    where: { OR: keys.map((k) => ({ key: { startsWith: k } })) },
  });
  keys = [];
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("rateLimit against real Postgres", () => {
  it("counts exactly under concurrency: 15 simultaneous calls, limit 5 → exactly 5 allowed", async () => {
    const key = newKey();

    const results = await Promise.all(
      Array.from({ length: 15 }, () => rateLimit(key, 5, WINDOW_MS)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed)).toHaveLength(10);

    const rows = await prisma.rateLimit.findMany({ where: { key: { startsWith: key } } });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(15);
  });

  it("keeps separate counts per key", async () => {
    const a = newKey();
    const b = newKey();

    await rateLimit(a, 1, WINDOW_MS);
    const aAgain = await rateLimit(a, 1, WINDOW_MS);
    const bFirst = await rateLimit(b, 1, WINDOW_MS);

    expect(aAgain.allowed).toBe(false);
    expect(bFirst.allowed).toBe(true);
  });

  it("reports how long until the window resets, and starts fresh in the next window", async () => {
    const key = newKey();
    await rateLimit(key, 1, WINDOW_MS);

    const blocked = await rateLimit(key, 1, WINDOW_MS);
    expect(blocked).toMatchObject({ allowed: false, retryAfterSeconds: 30 });

    vi.setSystemTime(MID_WINDOW + WINDOW_MS);
    expect((await rateLimit(key, 1, WINDOW_MS)).allowed).toBe(true);
  });

  it("purges expired rows", async () => {
    const key = newKey();
    await prisma.rateLimit.create({
      data: { key: `${key}:old`, count: 9, expiresAt: new Date(MID_WINDOW - 1_000) },
    });
    vi.spyOn(Math, "random").mockReturnValue(0); // force the opportunistic purge

    await rateLimit(key, 5, WINDOW_MS);

    expect(await prisma.rateLimit.findUnique({ where: { key: `${key}:old` } })).toBeNull();
  });
});
