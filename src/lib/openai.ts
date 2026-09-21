import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Constructed lazily (not at module scope) so that importing this file never
// throws just because OPENAI_API_KEY isn't set yet — e.g. during
// `next build`'s route collection, before any request actually needs it.
let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

/**
 * Asks OpenAI for a short, fun fact about a movie. Bounded by a request
 * timeout so a hung call fails fast instead of blocking the generation lock
 * for its full duration.
 */
export async function generateMovieFact(movie: string): Promise<string> {
  const completion = await getClient().chat.completions.create(
    {
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You share one short, fun, verifiably true fact about a movie the user names. " +
            "Respond with a single sentence, no preamble, no markdown, no quotation marks.",
        },
        { role: "user", content: movie },
      ],
      max_tokens: 120,
      temperature: 0.8,
    },
    { timeout: 10_000 },
  );

  const fact = completion.choices[0]?.message?.content?.trim();
  if (!fact) {
    throw new Error("OpenAI returned an empty response");
  }
  return fact;
}
