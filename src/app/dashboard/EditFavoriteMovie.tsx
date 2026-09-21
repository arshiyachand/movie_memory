"use client";

import { useActionState, useState } from "react";
import { updateFavoriteMovie, type UpdateMovieState } from "./actions";
import { MOVIE_MAX_LENGTH } from "@/lib/validation";

export default function EditFavoriteMovie({ movie }: { movie: string }) {
  const [editing, setEditing] = useState(false);

  const [state, formAction, isPending] = useActionState(
    async (prev: UpdateMovieState, formData: FormData) => {
      const next = await updateFavoriteMovie(prev, formData);
      if (next.saved) setEditing(false);
      return next;
    },
    {} as UpdateMovieState,
  );

  if (!editing) {
    return (
      <div className="flex items-center justify-between gap-4">
        <p className="text-lg font-medium">{movie}</p>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="shrink-0 text-sm font-medium underline underline-offset-4"
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          name="movie"
          type="text"
          required
          maxLength={MOVIE_MAX_LENGTH}
          defaultValue={movie}
          aria-label="Favorite movie"
          autoFocus
          className="w-full rounded-lg border border-black/10 bg-white px-3 py-1.5 text-black outline-none focus:border-black/30 dark:border-white/20"
        />
        <button
          type="submit"
          disabled={isPending}
          className="shrink-0 rounded-full bg-black px-4 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="shrink-0 text-sm underline underline-offset-4"
        >
          Cancel
        </button>
      </div>
      {state.error && (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
