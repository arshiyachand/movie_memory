// Wire types for /api/fact, shared by the route handler and the client so the
// client reads an explicit `status` instead of guessing from HTTP codes or
// message text.

export type FactDto = { content: string; createdAt: string };

export type FactApiStatus =
  | "fresh" // served from the 60s cache
  | "generated" // a new fact was just generated
  | "in_progress" // another request is generating; poll GET /api/fact
  | "rate_limited"
  | "no_movie"
  | "error";

/** Response body of POST /api/fact. */
export type FactApiResponse = {
  status: FactApiStatus;
  /** The best fact we have for the current movie (may be an older one). */
  fact?: FactDto | null;
  message?: string;
  error?: string;
  retryAfterSeconds?: number;
};

/** Response body of GET /api/fact — a pure read that never triggers generation. */
export type FactPeekResponse = {
  fact: FactDto | null;
  /** True while a generation for this user is currently in flight. */
  generating: boolean;
};
