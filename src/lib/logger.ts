import pino from "pino";

/**
 * JSON structured logs (one object per line) so they can be filtered and
 * aggregated by field in any log platform. Every event carries an `event`
 * name; callers add `userId` and `durationMs` where relevant.
 *
 * Never log emails, session tokens, OAuth tokens or API keys. Only the
 * opaque internal `userId` identifies a user.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info"),
  base: { service: "movie-memory" },
  // Safety net in case a whole request/session/config object is ever logged.
  redact: {
    paths: [
      "email",
      "*.email",
      "token",
      "*.token",
      "apiKey",
      "*.apiKey",
      "headers.authorization",
      "headers.cookie",
    ],
    censor: "[redacted]",
  },
});

const MAX_MESSAGE_LENGTH = 300;

/**
 * Pulls only the safe, useful parts out of an unknown error: its HTTP
 * `status` (OpenAI SDK errors have one) and a scrubbed, length-capped
 * message. Deliberately does not log the error object itself, which for SDK
 * errors can carry request headers.
 *
 * Scrubbing matters: OpenAI's 401 message echoes a partially masked key
 * ("Incorrect API key provided: sk-abc***xyz").
 */
export function errorFields(err: unknown): {
  errorStatus?: number;
  errorMessage: string;
} {
  const raw = err instanceof Error ? err.message : String(err);
  const errorMessage = raw
    .replace(/sk-[A-Za-z0-9_*.-]+/g, "sk-[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, MAX_MESSAGE_LENGTH);

  const status =
    typeof err === "object" && err !== null && "status" in err
      ? (err as { status?: unknown }).status
      : undefined;

  return typeof status === "number"
    ? { errorStatus: status, errorMessage }
    : { errorMessage };
}
