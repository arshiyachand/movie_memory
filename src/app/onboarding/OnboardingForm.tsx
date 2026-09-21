"use client";

import { useActionState } from "react";
import { saveFavoriteMovie, type OnboardingState } from "./actions";
import { MOVIE_MAX_LENGTH } from "@/lib/validation";

const initialState: OnboardingState = {};

export default function OnboardingForm() {
  const [state, formAction, isPending] = useActionState(
    saveFavoriteMovie,
    initialState,
  );

  return (
    <form action={formAction} className="mt-8 w-full max-w-sm">
      <label htmlFor="movie" className="block text-sm font-medium">
        Favorite movie
      </label>
      <input
        id="movie"
        name="movie"
        type="text"
        required
        maxLength={MOVIE_MAX_LENGTH}
        placeholder="e.g. The Princess Bride"
        autoFocus
        className="mt-2 w-full rounded-lg border border-black/10 bg-white px-4 py-2.5 text-black shadow-sm outline-none focus:border-black/30 dark:border-white/20"
      />
      {state.error && (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={isPending}
        className="mt-4 w-full rounded-lg bg-black px-4 py-2.5 font-medium text-white transition disabled:opacity-60 dark:bg-white dark:text-black"
      >
        {isPending ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}
