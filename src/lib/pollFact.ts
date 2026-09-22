import type { FactDto, FactPeekResponse } from "@/lib/factApi";

// ~5 tries over roughly 9s — a bit shorter than the server's generation
// budget (10s worst case), so a healthy generation is usually picked up in
// time, though the last try can still land just before it finishes.
export const DEFAULT_POLL_DELAYS_MS = [1_000, 2_000, 2_000, 2_000, 2_000];

export type PollOutcome =
  | { kind: "ready"; fact: FactDto | null } // generation finished
  | { kind: "timeout" } // still generating after the last try
  | { kind: "cancelled" }; // aborted (e.g. the component unmounted)

/** Resolves true after `ms`, or false right away if `signal` aborts first. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Polls a side-effect-free "peek" endpoint until the server reports that no
 * generation is in flight, waiting `delaysMs[i]` before try i. Never triggers
 * generation itself (peek is read-only) and stops immediately on abort.
 * A failed poll (network blip) just counts as a try.
 */
export async function pollUntilSettled(opts: {
  fetchPeek: (signal: AbortSignal) => Promise<FactPeekResponse>;
  signal: AbortSignal;
  delaysMs?: number[];
}): Promise<PollOutcome> {
  const { fetchPeek, signal, delaysMs = DEFAULT_POLL_DELAYS_MS } = opts;

  for (const delay of delaysMs) {
    if (!(await abortableSleep(delay, signal))) return { kind: "cancelled" };
    try {
      const peek = await fetchPeek(signal);
      if (signal.aborted) return { kind: "cancelled" };
      if (!peek.generating) return { kind: "ready", fact: peek.fact };
    } catch {
      if (signal.aborted) return { kind: "cancelled" };
    }
  }
  return { kind: "timeout" };
}
