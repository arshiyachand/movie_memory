import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getOrGenerateFact, peekFact } from "@/lib/factService";
import { rateLimit } from "@/lib/rateLimit";
import { logger } from "@/lib/logger";
import type { FactApiResponse, FactPeekResponse } from "@/lib/factApi";

// Per user. Generous for real use (the 60s cache means at most one OpenAI call
// a minute regardless), but stops a script hammering the endpoint. Polling
// (GET) is cheap reads, so it gets a higher ceiling of its own.
const POST_LIMIT = 10;
const GET_LIMIT = 60;
const WINDOW_MS = 60_000;

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: FactApiResponse | FactPeekResponse, init?: ResponseInit) {
  return NextResponse.json(body, init);
}

/** Returns a 429 response if `userId` is over `limit` for this route, else null. */
async function limited(userId: string, route: "fact" | "factpeek", limit: number) {
  const result = await rateLimit(`${route}:${userId}`, limit, WINDOW_MS);
  if (result.allowed) return null;

  logger.warn(
    { event: "rate_limited", userId, route, retryAfterSeconds: result.retryAfterSeconds },
    "fact request rate limited",
  );
  return json(
    {
      status: "rate_limited",
      error: "Too many requests. Please slow down and try again shortly.",
      retryAfterSeconds: result.retryAfterSeconds,
    },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
  );
}

/**
 * Reads the latest fact for the signed-in user's current movie and whether a
 * generation is in flight. Never triggers generation, so it is safe to poll.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return json({ status: "error", error: "Not signed in." }, { status: 401 });
  }

  const tooMany = await limited(session.user.id, "factpeek", GET_LIMIT);
  if (tooMany) return tooMany;

  const { fact, generating } = await peekFact(session.user.id);
  return json({ fact: fact && toDto(fact), generating }, { headers: NO_STORE });
}

/**
 * Generates (or returns a cached) fun fact about the signed-in user's
 * favorite movie. Always scoped to `session.user.id` — there is no userId
 * in the request, so there's no way to read or write another user's data.
 *
 * Every response carries an explicit `status` (see lib/factApi.ts).
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return json({ status: "error", error: "Not signed in." }, { status: 401 });
  }

  const tooMany = await limited(session.user.id, "fact", POST_LIMIT);
  if (tooMany) return tooMany;

  const result = await getOrGenerateFact(session.user.id);

  switch (result.status) {
    case "fresh":
    case "generated":
      return json({ status: result.status, fact: toDto(result.fact) });

    case "in_progress":
      return json(
        {
          status: "in_progress",
          fact: result.fact && toDto(result.fact),
          message: result.fact
            ? "A new fact is already being generated — showing the last one for now."
            : "Generating your fact…",
        },
        { status: result.fact ? 200 : 202 },
      );

    case "no_movie":
      return json(
        { status: "no_movie", error: "Add a favorite movie before generating a fact." },
        { status: 400 },
      );

    case "error":
      return json(
        {
          status: "error",
          fact: result.fact && toDto(result.fact),
          error: result.message,
        },
        { status: result.fact ? 200 : 503 },
      );
  }
}

function toDto(fact: { content: string; createdAt: Date }) {
  return { content: fact.content, createdAt: fact.createdAt.toISOString() };
}
