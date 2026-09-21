import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/factService", () => ({ getOrGenerateFact: vi.fn() }));

import { auth } from "@/lib/auth";
import { getOrGenerateFact } from "@/lib/factService";
import { POST } from "./route";

// `auth` is a heavily overloaded function type (route handler, middleware,
// getServerSideProps, plain call); cast to the plain-call signature we
// actually use so the mock isn't forced into an unrelated overload.
const mockAuth = auth as unknown as ReturnType<
  typeof vi.fn<() => Promise<{ user: { id: string } } | null>>
>;
const mockGetOrGenerateFact = vi.mocked(getOrGenerateFact);

beforeEach(() => {
  vi.clearAllMocks();
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
