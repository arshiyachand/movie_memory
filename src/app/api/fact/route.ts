import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getOrGenerateFact } from "@/lib/factService";

/**
 * Generates (or returns a cached) fun fact about the signed-in user's
 * favorite movie. Always scoped to `session.user.id` — there is no userId
 * in the request, so there's no way to read or write another user's data.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const result = await getOrGenerateFact(session.user.id);

  switch (result.status) {
    case "fresh":
    case "generated":
      return NextResponse.json({
        fact: result.fact,
        cached: result.status === "fresh",
      });

    case "in_progress":
      return NextResponse.json(
        {
          fact: result.fact,
          message: result.fact
            ? "A new fact is already being generated — showing the last one for now."
            : "Generating your fact, try again shortly.",
        },
        { status: result.fact ? 200 : 202 },
      );

    case "no_movie":
      return NextResponse.json(
        { error: "Add a favorite movie before generating a fact." },
        { status: 400 },
      );

    case "error":
      return NextResponse.json(
        { fact: result.fact, error: result.message },
        { status: result.fact ? 200 : 503 },
      );
  }
}
