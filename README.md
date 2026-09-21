# Movie Memory

Sign in with Google, tell the app your favorite movie, and get a fun,
AI-generated fact about it — cached for 60 seconds and protected against
duplicate concurrent generations.

**Stack:** TypeScript, Next.js (App Router), React, Tailwind CSS, PostgreSQL,
Prisma, NextAuth.js (Google OAuth), OpenAI API.

**Chosen variant:** **A — Caching + Correctness** (see below for why, and the
tradeoffs involved).

---

## 1. Setup

### Prerequisites

- Node.js 20+
- A PostgreSQL database (local via Docker/Postgres.app, or a hosted one like
  Supabase/Neon/Railway)
- A Google Cloud OAuth client
- An OpenAI API key

### Install

```bash
npm install
```

### Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string, e.g. `postgresql://user:pass@localhost:5432/movie_memory` |
| `NEXTAUTH_SECRET` | Random secret NextAuth uses to sign session/cookie data. Generate with `npx auth secret` or `openssl rand -base64 32` |
| `NEXTAUTH_URL` | Base URL of the app, e.g. `http://localhost:3000` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From a Google Cloud OAuth 2.0 Client ID (see below) |
| `OPENAI_API_KEY` | Your OpenAI API key |
| `OPENAI_MODEL` | Optional, defaults to `gpt-4o-mini` |

**Google OAuth setup:**

1. Go to [Google Cloud Console → APIs & Credentials](https://console.cloud.google.com/apis/credentials).
2. Create an OAuth 2.0 Client ID (Web application).
3. Add authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
   (and your production URL's equivalent later).
4. Copy the Client ID / Secret into `.env`.

None of these secrets are ever sent to the browser — they're only read in
server-side code (`route.ts` handlers, server components, server actions).

### Database migration

```bash
npx prisma migrate dev --name init
```

This creates the tables from `prisma/schema.prisma` (`User`, `Account`,
`Session`, `VerificationToken`, `Fact`) and generates the Prisma Client.

### Run

```bash
npm run dev
```

Visit `http://localhost:3000`.

### Tests

```bash
npm test
```

Runs the Vitest suite covering the cache window, the generation-in-progress
guard, failure fallback, and authorization on `/api/fact` — all against
mocked Prisma/OpenAI, no real DB or API calls needed.

---

## 2. Architecture overview

### Auth flow

NextAuth.js (v5) with the Prisma adapter and Google as the only provider.
Sessions use the **database** strategy (not JWT): every `auth()` call reads
`Session` + `User` straight from Postgres. This matters for the onboarding
gate — the moment a user submits their favorite movie, the very next request
must see it. A JWT session would carry a stale copy of the user in an
encrypted cookie until the token naturally refreshes; database sessions have
no such lag.

Routing logic lives in the pages themselves rather than in a separate
`middleware.ts`:

- `/` (landing): if signed in, reads `favoriteMovie` and redirects to
  `/onboarding` or `/dashboard`; if signed out, renders the sign-in button.
- `/onboarding`: redirects to `/` if signed out, redirects to `/dashboard` if
  already onboarded, otherwise renders the form.
- `/dashboard`: redirects to `/` if signed out, redirects to `/onboarding` if
  no favorite movie is set yet.

This was chosen over Next.js `middleware.ts` because middleware in this app
would need to run in the Node.js runtime anyway to query Prisma for the
onboarding check (Prisma's engine isn't Edge-compatible in this setup), so
there was no simplification to be had from moving the check there — doing it
in each Server Component keeps the logic colocated with the page it protects
and is exactly as strict (every protected page independently checks
`auth()`, it doesn't rely on a request having passed through a specific
middleware matcher).

### Data model

```
User
 ├─ id, name, email, image           (from Google, via the adapter)
 ├─ favoriteMovie   String?          (set once, during onboarding)
 ├─ generationStartedAt DateTime?    (nullable lock, see below)
 └─ facts  Fact[]

Fact
 ├─ id, userId, content, createdAt
```

`favoriteMovie` and `generationStartedAt` live on `User` rather than `Fact`
because they describe the *next* generation, which by definition doesn't
have a `Fact` row yet — there's exactly one favorite movie and one
in-flight-generation state per user, not per fact.

### Fact generation: cache + lock (`src/lib/factService.ts`)

`getOrGenerateFact(userId)` is called from `POST /api/fact` (which does
nothing but check `auth()` and map the result to an HTTP status — all real
logic is in the service function so it's unit-testable without spinning up
a server):

1. Load the user's `favoriteMovie`. If unset, return `no_movie` (400).
2. Load the most recent `Fact` for this user.
3. If it exists and is **< 60s old**, return it — no OpenAI call.
4. Otherwise, try to **atomically acquire the generation lock**:
   ```ts
   prisma.user.updateMany({
     where: {
       id: userId,
       OR: [{ generationStartedAt: null }, { generationStartedAt: { lt: staleBefore } }],
     },
     data: { generationStartedAt: new Date() },
   });
   ```
   If `count === 1`, this request won the lock and proceeds to call OpenAI.
   If `count === 0`, someone else already holds a fresh lock — return the
   most recent cached fact (even if stale) instead of calling OpenAI again.
5. On success: save the new `Fact`, clear `generationStartedAt`, return it.
6. On failure (timeout/error): clear `generationStartedAt` in a `finally`-style
   path, then fall back to the last cached fact if one exists, otherwise
   return a clean `{ error: "..." }` JSON response (never a raw stack trace).

A stale lock (`generationStartedAt` older than 15s) is treated as abandoned,
so a crashed request can't permanently wedge future generations for that
user.

**Timing invariant: generation must finish before the lock can go stale.**
If an OpenAI call could outlive `LOCK_STALE_MS`, a second request would see
the lock as abandoned, take it, and fire a duplicate call while the first is
still running — exactly what the lock exists to prevent. The OpenAI SDK's own
defaults break this: it retries twice, each attempt gets a full timeout, and
it honors `Retry-After` for up to 60s, so a struggling call can take 30s+.
So the SDK's retries are turned off (`maxRetries: 0`) and
`src/lib/retry.ts` retries transient errors (connection errors/timeouts,
408, 409, 429, 5xx) itself under one total budget. That budget,
`GENERATION_BUDGET_MS`, is derived in `factService.ts` as
`LOCK_STALE_MS - 5s`, so it is shorter than the stale window by construction,
and a unit test asserts it. Each attempt's timeout shrinks to the budget
remaining, so the last retry cannot overrun the deadline.

---

## 3. Why Variant A, and the locking tradeoff

**Variant A (Caching + Correctness)** was chosen because it's the piece of
this app most likely to actually break in a multi-instance deployment (the
default for Next.js on Vercel or any horizontally-scaled setup), and getting
it right is a good proxy for backend correctness thinking under concurrency
— which is the more interesting problem here than, say, additional UI
polish.

### DB flag vs. in-memory lock vs. DB transaction guard

Three ways to implement the "don't call OpenAI twice for the same user
within the same few seconds" guard were considered:

1. **In-memory lock** (e.g. a `Map<userId, boolean>` in the Node process).
   Rejected: Next.js route handlers can run across multiple serverless
   invocations or multiple server instances behind a load balancer. An
   in-memory lock is only visible to the one process that set it — a second
   request routed to a different instance would see no lock at all and
   would happily fire a second OpenAI call. This defeats the entire point of
   the guard in any real deployment.

2. **Postgres-backed flag with a conditional `UPDATE ... WHERE`** (what's
   implemented here). A single atomic statement both checks the lock's
   state *and* claims it, scoped by `id: userId` plus "lock is null or
   stale." Postgres serializes concurrent `UPDATE`s to the same row: if two
   requests race, the second one's `WHERE` clause is re-evaluated against
   the first one's already-committed write and no longer matches, so it
   affects 0 rows. `result.count` alone tells the caller whether it won,
   with no separate read-then-write round trip and no window for a race
   between "check" and "set." This works correctly across any number of
   server instances because the coordination happens in the database, not
   in application memory — which is exactly the property the in-memory
   approach lacks.

3. **Explicit DB transaction wrapping a read + write** (`BEGIN; SELECT ...
   FOR UPDATE; ... COMMIT;`). This would also be correct, but it's strictly
   more machinery for the same guarantee: it needs an explicit transaction,
   a row lock via `SELECT ... FOR UPDATE`, and careful handling of how long
   the transaction (and its connection) is held open while the OpenAI call
   runs — which is a bad idea, since you'd either have to hold the
   transaction open for the whole OpenAI call (tying up a DB connection for
   up to 10s) or split it into two transactions, at which point you've
   reinvented option 2 with extra steps. The conditional `UPDATE` gets the
   same atomicity guarantee from Postgres's normal row-level locking on a
   single statement, with no long-held transaction.

Option 2 was implemented as the best balance of correctness and simplicity.

---

## 4. What I'd improve with two more hours

- **Rate limiting** on `/api/fact` per user (e.g. N requests/minute) — right
  now the cache window incidentally limits OpenAI spend, but a user could
  still hammer the endpoint once every 60s indefinitely.
- **Structured logging** around lock acquisition/failure (right now failures
  are swallowed into a generic user-facing message with no server-side trace
  of *why* OpenAI failed).
- **Optimistic UI** for fact generation (skeleton/shimmer instead of a plain
  "Generating…" label), and a small polling loop so a client that got the
  `in_progress`/202 response automatically retries instead of requiring
  another manual click.
- **Editable favorite movie** after onboarding (currently write-once) — would
  need to decide whether to invalidate cached facts as soon as it changes, or
  merely on the next fetch.
- **Integration tests against a real Postgres** (e.g. via a Testcontainers
  instance) to verify the atomic-update race behavior under actual
  concurrent load, rather than only unit-testing the logic against mocks.
- **Compare-and-delete lock release.** `clearLock` clears the lock
  unconditionally; if a holder ever outlived the stale window (e.g. a DB
  stall after OpenAI returned), it could release someone else's lock. Storing
  a per-acquisition token and clearing only if it still matches would close
  that.
- **Re-check the cache after winning the lock**, so a request that read a
  stale fact just before another finished generating doesn't produce a second
  fact within the 60s window.

## Known limitations

- OpenAI-generated facts are not fact-checked by this app; treat them as
  "fun," not "verified."
- The favorite movie is a free-text field with only length validation — no
  attempt is made to verify it's a real movie title.
