"use server";

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateMovieTitle } from "@/lib/validation";

export type OnboardingState = { error?: string };

export async function saveFavoriteMovie(
  _prevState: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/");
  }

  const result = validateMovieTitle(formData.get("movie"));
  if (!result.ok) {
    return { error: result.error };
  }

  await prisma.user.update({
    where: { id: session.user.id },
    data: { favoriteMovie: result.value },
  });

  redirect("/dashboard");
}
