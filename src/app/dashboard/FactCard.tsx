"use client";

import { useState } from "react";

type Fact = { content: string; createdAt: string };

type FactResponse = {
  fact?: Fact | null;
  cached?: boolean;
  message?: string;
  error?: string;
};

export default function FactCard({
  movie,
  initialFact,
}: {
  movie: string;
  initialFact: Fact | null;
}) {
  const [fact, setFact] = useState<Fact | null>(initialFact);
  const [status, setStatus] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleGenerate() {
    setIsLoading(true);
    setStatus(null);
    try {
      const res = await fetch("/api/fact", { method: "POST" });
      const data: FactResponse = await res.json();

      if (data.fact) {
        setFact(data.fact);
      }
      if (data.error) {
        setStatus(data.error);
      } else if (data.message) {
        setStatus(data.message);
      } else if (data.cached) {
        setStatus("Showing a recently generated fact.");
      }
    } catch {
      setStatus("Something went wrong reaching the server. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-black/10 p-5 dark:border-white/20">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-semibold">Fun fact about {movie}</h2>
        <button
          onClick={handleGenerate}
          disabled={isLoading}
          className="shrink-0 rounded-full bg-black px-4 py-1.5 text-sm font-medium text-white transition disabled:opacity-60 dark:bg-white dark:text-black"
        >
          {isLoading ? "Generating…" : fact ? "Get another fact" : "Get a fun fact"}
        </button>
      </div>

      {fact ? (
        <div className="mt-4">
          <p className="text-foreground/90">{fact.content}</p>
          <p className="mt-2 text-xs text-foreground/50">
            Generated {new Date(fact.createdAt).toLocaleString()}
          </p>
        </div>
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
