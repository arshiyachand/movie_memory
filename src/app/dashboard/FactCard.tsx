"use client";

import { useEffect, useRef, useState } from "react";
import type { FactApiResponse, FactDto, FactPeekResponse } from "@/lib/factApi";
import { pollUntilSettled } from "@/lib/pollFact";

type Phase = "idle" | "loading" | "waiting";

async function fetchPeek(signal: AbortSignal): Promise<FactPeekResponse> {
  const res = await fetch("/api/fact", { method: "GET", signal });
  if (!res.ok) throw new Error(`peek failed: ${res.status}`);
  return res.json();
}

export default function FactCard({
  movie,
  initialFact,
}: {
  movie: string;
  initialFact: FactDto | null;
}) {
  const [fact, setFact] = useState<FactDto | null>(initialFact);
  const [status, setStatus] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");

  // Aborts the in-flight request and any polling — used when a new click
  // supersedes it and when the component unmounts.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  async function handleGenerate() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    setPhase("loading");
    setStatus(null);

    try {
      const res = await fetch("/api/fact", { method: "POST", signal });
      const data: FactApiResponse = await res.json();
      if (signal.aborted) return;

      if (data.fact) setFact(data.fact);

      switch (data.status) {
        case "fresh":
          setStatus("Showing a recently generated fact.");
          break;
        case "generated":
          break;
        case "in_progress": {
          // Another request is already generating: wait for it by polling the
          // read-only endpoint, rather than asking the user to click again.
          setPhase("waiting");
          setStatus(data.message ?? "Generating your fact…");
          const outcome = await pollUntilSettled({ fetchPeek, signal });
          if (outcome.kind === "cancelled") return;
          if (outcome.kind === "ready") {
            if (outcome.fact) setFact(outcome.fact);
            setStatus(null);
          } else {
            setStatus("Still working on it — please try again in a moment.");
          }
          break;
        }
        case "rate_limited":
          setStatus(
            data.retryAfterSeconds
              ? `Too many requests. Try again in ${data.retryAfterSeconds}s.`
              : (data.error ?? "Too many requests."),
          );
          break;
        case "no_movie":
        case "error":
          setStatus(data.error ?? "Something went wrong. Please try again.");
          break;
      }
    } catch {
      if (signal.aborted) return;
      setStatus("Something went wrong reaching the server. Please try again.");
    }
    if (!signal.aborted) setPhase("idle");
  }

  const busy = phase !== "idle";

  return (
    <div className="rounded-xl border border-black/10 p-5 dark:border-white/20">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-semibold">Fun fact about {movie}</h2>
        <button
          onClick={handleGenerate}
          disabled={busy}
          className="shrink-0 rounded-full bg-black px-4 py-1.5 text-sm font-medium text-white transition disabled:opacity-60 dark:bg-white dark:text-black"
        >
          {busy ? "Generating…" : fact ? "Get another fact" : "Get a fun fact"}
        </button>
      </div>

      {fact ? (
        <div className={`mt-4 transition-opacity ${busy ? "opacity-50" : ""}`} aria-busy={busy}>
          <p className="text-foreground/90">{fact.content}</p>
          <p className="mt-2 text-xs text-foreground/50">
            Generated {new Date(fact.createdAt).toLocaleString()}
          </p>
        </div>
      ) : busy ? (
        <FactSkeleton />
      ) : (
        <p className="mt-4 text-sm text-foreground/60">
          No fact generated yet — click the button above.
        </p>
      )}

      {status && (
        <p className="mt-3 text-sm text-foreground/60" role="status">
          {status}
        </p>
      )}
    </div>
  );
}

function FactSkeleton() {
  return (
    <div className="mt-4 animate-pulse space-y-2" role="status" aria-label="Loading fact">
      <div className="h-4 w-full rounded bg-black/10 dark:bg-white/10" />
      <div className="h-4 w-4/5 rounded bg-black/10 dark:bg-white/10" />
      <div className="mt-3 h-3 w-1/3 rounded bg-black/10 dark:bg-white/10" />
    </div>
  );
}
