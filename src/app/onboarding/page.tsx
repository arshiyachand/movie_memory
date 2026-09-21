import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import OnboardingForm from "./OnboardingForm";

export default async function OnboardingPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/");
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { favoriteMovie: true },
  });
  if (user?.favoriteMovie) {
    redirect("/dashboard");
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-bold">What&apos;s your favorite movie?</h1>
      <p className="mt-2 text-sm text-foreground/70">
        We&apos;ll use it to generate fun facts for your dashboard.
      </p>
      <OnboardingForm />
    </main>
  );
}
