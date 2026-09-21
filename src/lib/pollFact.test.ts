import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pollUntilSettled, abortableSleep } from "@/lib/pollFact";
import type { FactPeekResponse } from "@/lib/factApi";

const FACT = { content: "a fact", createdAt: "2026-01-01T00:00:00.000Z" };
const DELAYS = [1_000, 2_000, 2_000];

const generating: FactPeekResponse = { fact: null, generating: true };
const done: FactPeekResponse = { fact: FACT, generating: false };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("pollUntilSettled", () => {
  it("waits the first delay, then returns as soon as generation has finished", async () => {
    const fetchPeek = vi
      .fn()
      .mockResolvedValueOnce(generating)
      .mockResolvedValueOnce(done);
    const controller = new AbortController();

    const promise = pollUntilSettled({ fetchPeek, signal: controller.signal, delaysMs: DELAYS });

    // Nothing is requested until the first delay has elapsed.
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchPeek).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1); // t=1s: first poll (still generating)
    expect(fetchPeek).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000); // t=3s: second poll (done)

    await expect(promise).resolves.toEqual({ kind: "ready", fact: FACT });
    expect(fetchPeek).toHaveBeenCalledTimes(2);
  });

  it("gives up with a timeout after the last try if generation never finishes", async () => {
    const fetchPeek = vi.fn().mockResolvedValue(generating);
    const controller = new AbortController();

    const promise = pollUntilSettled({ fetchPeek, signal: controller.signal, delaysMs: DELAYS });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ kind: "timeout" });
    expect(fetchPeek).toHaveBeenCalledTimes(DELAYS.length);
  });

  it("counts a failed poll as a try instead of throwing", async () => {
    const fetchPeek = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(done);
    const controller = new AbortController();

    const promise = pollUntilSettled({ fetchPeek, signal: controller.signal, delaysMs: DELAYS });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ kind: "ready", fact: FACT });
  });

  it("stops immediately when aborted (e.g. the component unmounted) and makes no more requests", async () => {
    const fetchPeek = vi.fn().mockResolvedValue(generating);
    const controller = new AbortController();

    const promise = pollUntilSettled({ fetchPeek, signal: controller.signal, delaysMs: DELAYS });
    await vi.advanceTimersByTimeAsync(1_000); // first poll happens
    expect(fetchPeek).toHaveBeenCalledTimes(1);

    controller.abort();
    await expect(promise).resolves.toEqual({ kind: "cancelled" });

    await vi.runAllTimersAsync();
    expect(fetchPeek).toHaveBeenCalledTimes(1);
  });

  it("does not poll at all if already aborted", async () => {
    const fetchPeek = vi.fn();
    const controller = new AbortController();
    controller.abort();

    const outcome = await pollUntilSettled({ fetchPeek, signal: controller.signal, delaysMs: DELAYS });

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(fetchPeek).not.toHaveBeenCalled();
  });
});

describe("abortableSleep", () => {
  it("resolves true after the delay and false if aborted first", async () => {
    const a = new AbortController();
    const done = abortableSleep(500, a.signal);
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toBe(true);

    const b = new AbortController();
    const cut = abortableSleep(500, b.signal);
    b.abort();
    await expect(cut).resolves.toBe(false);
  });
});
