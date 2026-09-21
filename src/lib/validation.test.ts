import { describe, it, expect } from "vitest";
import {
  validateMovieTitle,
  normalizeMovieTitle,
  MOVIE_MAX_LENGTH,
} from "@/lib/validation";

describe("normalizeMovieTitle", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeMovieTitle("  The    Matrix \t")).toBe("The Matrix");
    expect(normalizeMovieTitle("Spirited\n Away")).toBe("Spirited Away");
  });
});

describe("validateMovieTitle", () => {
  it("returns the normalized value", () => {
    expect(validateMovieTitle("  Blade   Runner 2049 ")).toEqual({
      ok: true,
      value: "Blade Runner 2049",
    });
  });

  it("rejects empty, whitespace-only and non-string input", () => {
    expect(validateMovieTitle("")).toMatchObject({ ok: false });
    expect(validateMovieTitle("   ")).toMatchObject({ ok: false });
    expect(validateMovieTitle(null)).toMatchObject({ ok: false });
    expect(validateMovieTitle(42)).toMatchObject({ ok: false });
  });

  it("enforces the max length after normalizing", () => {
    expect(validateMovieTitle("a".repeat(MOVIE_MAX_LENGTH))).toMatchObject({ ok: true });
    expect(validateMovieTitle("a".repeat(MOVIE_MAX_LENGTH + 1))).toMatchObject({ ok: false });
    // Padding whitespace must not count against the limit.
    expect(validateMovieTitle(`   ${"a".repeat(MOVIE_MAX_LENGTH)}   `)).toMatchObject({ ok: true });
  });
});
