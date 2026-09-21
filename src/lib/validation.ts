export const MOVIE_MIN_LENGTH = 1;
export const MOVIE_MAX_LENGTH = 100;

export type MovieValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/** Server-side validation for the favorite-movie field: trim, then enforce length. */
export function validateMovieTitle(raw: unknown): MovieValidationResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "Please enter a movie title." };
  }
  const value = raw.trim();
  if (value.length < MOVIE_MIN_LENGTH) {
    return { ok: false, error: "Please enter a movie title." };
  }
  if (value.length > MOVIE_MAX_LENGTH) {
    return {
      ok: false,
      error: `Movie title must be ${MOVIE_MAX_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true, value };
}
