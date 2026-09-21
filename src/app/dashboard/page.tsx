import Image from "next/image";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import LogoutButton from "./LogoutButton";
import FactCard from "./FactCard";
import EditFavoriteMovie from "./EditFavoriteMovie";
import { getLatestFact } from "@/lib/factService";
import { normalizeMovieTitle } from "@/lib/validation";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/");
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      name: true,
      email: true,
      image: true,
      favoriteMovie: true,
    },
  });

  if (!user) {
    redirect("/");
  }
  if (!user.favoriteMovie) {
    redirect("/onboarding");
  }

  const displayName = user.name?.trim() || user.email || "there";
  // Only a fact about the *current* favorite movie is shown.
  const stored = await getLatestFact(
    session.user.id,
    normalizeMovieTitle(user.favoriteMovie),
  );
  const latestFact = stored
    ? { content: stored.content, createdAt: stored.createdAt.toISOString() }
    : null;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          {user.image ? (
            <Image
              src={user.image}
              alt=""
              width={56}
              height={56}
              className="rounded-full"
            />
          ) : (
            <div
              className="flex h-14 w-14 items-center justify-center rounded-full bg-black/10 text-lg font-semibold dark:bg-white/10"
              aria-hidden="true"
            >
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="text-xl font-bold">{displayName}</h1>
            {user.email && (
              <p className="text-sm text-foreground/60">{user.email}</p>
            )}
          </div>
        </div>
        <LogoutButton />
      </div>

      <div className="rounded-xl border border-black/10 p-5 dark:border-white/20">
        <p className="text-sm text-foreground/60">Favorite movie</p>
        <div className="mt-1">
          <EditFavoriteMovie movie={user.favoriteMovie} />
        </div>
      </div>

      <FactCard
        key={user.favoriteMovie}
        movie={user.favoriteMovie}
        initialFact={latestFact}
      />
    </main>
  );
}
