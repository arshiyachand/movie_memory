export type RetryOptions = {
  /** Hard ceiling on total wall-clock time across all attempts and backoff sleeps. */
  budgetMs: number;
  maxAttempts: number;
  /** Upper bound for one attempt; shrinks to whatever budget is left. */
  attemptTimeoutMs: number;
  /** First backoff delay; doubles each retry, with up to 25% jitter shaved off. */
  baseDelayMs: number;
  isRetryable: (err: unknown) => boolean;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` with retries, guaranteeing the whole thing (attempts plus
 * backoff sleeps) finishes within `budgetMs`. Each attempt is handed the
 * timeout it may use: the smaller of `attemptTimeoutMs` and the budget left,
 * so a late retry can never overrun the deadline.
 *
 * Callers rely on that ceiling: the fact-generation lock is only considered
 * abandoned after LOCK_STALE_MS, so the budget must stay under it.
 */
export async function retryWithinBudget<T>(
  attempt: (timeoutMs: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const deadline = Date.now() + opts.budgetMs;

  for (let n = 1; ; n++) {
    const remaining = deadline - Date.now();
    try {
      return await attempt(Math.min(opts.attemptTimeoutMs, remaining));
    } catch (err) {
      if (n >= opts.maxAttempts || !opts.isRetryable(err)) throw err;

      const delay = opts.baseDelayMs * 2 ** (n - 1) * (1 - Math.random() * 0.25);
      // Not enough budget left to sleep and still make a meaningful attempt.
      if (deadline - Date.now() <= delay) throw err;
      await sleep(delay);
    }
  }
}
