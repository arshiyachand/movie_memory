import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { retryWithinBudget, type RetryOptions } from "@/lib/retry";

const opts: RetryOptions = {
  budgetMs: 10_000,
  maxAttempts: 3,
  attemptTimeoutMs: 5_000,
  baseDelayMs: 400,
  isRetryable: (err) => err instanceof Error && err.message === "transient",
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("retryWithinBudget", () => {
  it("returns immediately when the first attempt succeeds", async () => {
    const attempt = vi.fn().mockResolvedValue("ok");

    await expect(retryWithinBudget(attempt, opts)).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("retries a transient error and returns the later success", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");

    const promise = retryWithinBudget(attempt, opts);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable error", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("bad api key"));

    await expect(retryWithinBudget(attempt, opts)).rejects.toThrow("bad api key");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("transient"));

    const promise = retryWithinBudget(attempt, opts);
    const assertion = expect(promise).rejects.toThrow("transient");
    await vi.runAllTimersAsync();

    await assertion;
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("never exceeds the total budget, even when every attempt uses its full timeout", async () => {
    // Each attempt burns exactly the timeout it is given, then fails —
    // the worst case for the lock-staleness window.
    const attempt = vi.fn(async (timeoutMs: number) => {
      await new Promise((r) => setTimeout(r, timeoutMs));
      throw new Error("transient");
    });

    const start = Date.now();
    const promise = retryWithinBudget(attempt, opts);
    const assertion = expect(promise).rejects.toThrow("transient");
    await vi.runAllTimersAsync();
    await assertion;

    expect(Date.now() - start).toBeLessThanOrEqual(opts.budgetMs);
  });

  it("shrinks the per-attempt timeout to the budget that remains", async () => {
    const timeouts: number[] = [];
    const attempt = vi.fn(async (timeoutMs: number) => {
      timeouts.push(timeoutMs);
      await new Promise((r) => setTimeout(r, timeoutMs));
      throw new Error("transient");
    });

    const promise = retryWithinBudget(attempt, opts);
    const assertion = expect(promise).rejects.toThrow("transient");
    await vi.runAllTimersAsync();
    await assertion;

    expect(timeouts[0]).toBe(opts.attemptTimeoutMs);
    // A later attempt is capped by what is left, never the full 5s.
    expect(Math.max(...timeouts.slice(1))).toBeLessThan(opts.attemptTimeoutMs);
  });
});
