"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateMovieTitle } from "@/lib/validation";

export type UpdateMovieState = { error?: string; saved?: boolean };

/**
 * Changes the signed-in user's favorite movie. Always scoped to the session's
 * user id — there is no user id in the form.
 */
export async function updateFavoriteMovie(
  _prevState: UpdateMovieState,
  formData: FormData,
): Promise<UpdateMovieState> {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "Please sign in again." };
  }

  const result = validateMovieTitle(formData.get("movie"));
  if (!result.ok) {
    return { error: result.error };
  }

  const userId = session.user.id;
  const current = await prisma.user.findUnique({
    where: { id: userId },
    select: { favoriteMovie: true },
  });
  const isDifferentMovie =
    current?.favoriteMovie?.toLowerCase() !== result.value.toLowerCase();

  await prisma.user.update({
    where: { id: userId },
    data: {
      favoriteMovie: result.value,
      // A generation in flight is for the old movie. Clear its lock so the
      // new movie isn't blocked behind it; the old request will notice the
      // change and discard its result, and (because lock release is scoped to
      // the holder's own timestamp) can't clear the new holder's lock.
      ...(isDifferentMovie ? { generationStartedAt: null } : {}),
    },
  });

  revalidatePath("/dashboard");
  return { saved: true };
}
