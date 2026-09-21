import OpenAI from "openai";
import { retryWithinBudget } from "@/lib/retry";
import { logger, errorFields } from "@/lib/logger";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const ATTEMPT_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 400;

// Constructed lazily (not at module scope) so that importing this file never
// throws just because OPENAI_API_KEY isn't set yet — e.g. during
// `next build`'s route collection, before any request actually needs it.
let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!client) {
    // maxRetries: 0 — the SDK defaults to 2 retries, each with its own full
    // timeout (plus backoff and any Retry-After wait of up to 60s), which
    // would make total time unbounded relative to the generation lock. We
    // retry ourselves in retryWithinBudget, under one overall time budget.
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  }
  return client;
}

/** Transient failures worth retrying; auth/validation errors would just fail again. */
function isTransient(err: unknown): boolean {
  if (err instanceof OpenAI.APIConnectionError) return true; // includes timeouts
  if (err instanceof OpenAI.APIError) {
    const s = err.status;
    return s === 408 || s === 409 || s === 429 || (s !== undefined && s >= 500);
  }
  return false;
}

/**
 * Asks OpenAI for a short, fun fact about a movie. Retries transient errors,
 * but never runs longer than `budgetMs` in total — the caller passes a budget
 * that is shorter than the lock's stale window, so the lock can't be taken
 * over while this call is still in flight.
 */
export async function generateMovieFact(
  movie: string,
  budgetMs: number,
): Promise<string> {
  const completion = await retryWithinBudget(
    (timeoutMs) =>
      getClient().chat.completions.create(
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
        { timeout: timeoutMs },
      ),
    {
      budgetMs,
      maxAttempts: MAX_ATTEMPTS,
      attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
      baseDelayMs: BASE_RETRY_DELAY_MS,
      isRetryable: isTransient,
      onRetry: (err, attempt, delayMs) =>
        logger.warn(
          { event: "openai_retry", attempt, delayMs: Math.round(delayMs), ...errorFields(err) },
          "retrying OpenAI request",
        ),
    },
  );

  const fact = completion.choices[0]?.message?.content?.trim();
  if (!fact) {
    throw new Error("OpenAI returned an empty response");
  }
  return fact;
}
