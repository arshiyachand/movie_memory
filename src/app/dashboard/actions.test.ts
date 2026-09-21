import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { updateFavoriteMovie } from "./actions";

// `auth` is heavily overloaded; cast to the plain-call signature we use.
const mockAuth = auth as unknown as ReturnType<
  typeof vi.fn<() => Promise<{ user: { id: string } } | null>>
>;
const mockPrisma = vi.mocked(prisma, true);

function form(movie: string) {
  const fd = new FormData();
  fd.set("movie", movie);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  mockPrisma.user.findUnique.mockResolvedValue({ favoriteMovie: "The Matrix" } as never);
});

describe("updateFavoriteMovie", () => {
  it("rejects a signed-out caller without touching the database", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await updateFavoriteMovie({}, form("Inception"));

    expect(result.error).toBeTruthy();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it("reuses validation and rejects an invalid title", async () => {
    const result = await updateFavoriteMovie({}, form("   "));

    expect(result.error).toBeTruthy();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it("saves the normalized title for the session user and clears the lock when the movie changes", async () => {
    const result = await updateFavoriteMovie({}, form("  Blade   Runner "));

    expect(result).toEqual({ saved: true });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { favoriteMovie: "Blade Runner", generationStartedAt: null },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("does not clear an in-flight lock when only the casing/spacing changed", async () => {
    await updateFavoriteMovie({}, form("the  matrix"));

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { favoriteMovie: "the matrix" },
    });
  });
});
