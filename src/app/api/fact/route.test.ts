import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/factService", () => ({ getOrGenerateFact: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { auth } from "@/lib/auth";
import { getOrGenerateFact } from "@/lib/factService";
import { rateLimit } from "@/lib/rateLimit";
import { logger } from "@/lib/logger";
import { POST } from "./route";

// `auth` is a heavily overloaded function type (route handler, middleware,
// getServerSideProps, plain call); cast to the plain-call signature we
// actually use so the mock isn't forced into an unrelated overload.
const mockAuth = auth as unknown as ReturnType<
  typeof vi.fn<() => Promise<{ user: { id: string } } | null>>
>;
const mockGetOrGenerateFact = vi.mocked(getOrGenerateFact);
const mockRateLimit = vi.mocked(rateLimit);

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue({ allowed: true, remaining: 9, retryAfterSeconds: 30 });
});

describe("POST /api/fact — authorization", () => {
  it("rejects unauthenticated requests without touching the fact service", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await POST();

    expect(res.status).toBe(401);
    expect(mockGetOrGenerateFact).not.toHaveBeenCalled();
  });

  it("only ever asks the fact service for the signed-in user's own id", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-42" } });
    mockGetOrGenerateFact.mockResolvedValue({
      status: "fresh",
      fact: { content: "fact", createdAt: new Date() },
    });

    await POST();

    // The route never reads a userId from the request itself — it can only
    // ever operate on whatever auth() returns for the current session, so
    // there is no way for a request to name another user's id.
    expect(mockGetOrGenerateFact).toHaveBeenCalledWith("user-42");
    expect(mockGetOrGenerateFact).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/fact — response mapping", () => {
  it("returns a friendly 503 (not a raw error) when generation fails with nothing cached", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockGetOrGenerateFact.mockResolvedValue({
      status: "error",
      message: "We couldn't generate a new fact right now. Please try again in a moment.",
      fact: null,
    });

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error).toContain("try again");
    expect(body).not.toHaveProperty("stack");
  });

  it("returns 202 for in-progress generation with no prior fact", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockGetOrGenerateFact.mockResolvedValue({ status: "in_progress", fact: null });

    const res = await POST();
    expect(res.status).toBe(202);
  });
});

describe("POST /api/fact — rate limiting", () => {
  it("returns 429 with a Retry-After header and never reaches the fact service when over the limit", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 42 });

    const res = await POST();

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(mockGetOrGenerateFact).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "rate_limited", userId: "user-1" }),
      expect.any(String),
    );
  });

  it("limits per signed-in user, and only after authenticating", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-7" } });
    mockGetOrGenerateFact.mockResolvedValue({
      status: "fresh",
      fact: { content: "fact", createdAt: new Date() },
    });

    await POST();

    expect(mockRateLimit).toHaveBeenCalledWith("fact:user-7", expect.any(Number), expect.any(Number));

    // Unauthenticated requests are rejected before consuming any quota.
    mockRateLimit.mockClear();
    mockAuth.mockResolvedValue(null);
    await POST();
    expect(mockRateLimit).not.toHaveBeenCalled();
  });
});
