import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  // Database sessions (not JWT): every `auth()` call re-reads the User row
  // from Postgres, so favoriteMovie is always fresh right after onboarding
  // with no stale-cookie lag.
  session: { strategy: "database" },
  // Explicit env var names (GOOGLE_CLIENT_ID/SECRET) rather than relying on
  // Auth.js's AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET convention, since those are
  // the names Google Cloud Console and this README both use.
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  pages: {
    signIn: "/",
  },
  callbacks: {
    // The adapter's default session callback already attaches user.id, but
    // we're explicit here since the rest of the app relies on it.
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
});
