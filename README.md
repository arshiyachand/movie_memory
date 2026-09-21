# Movie Memory

Sign in with Google, tell the app your favorite movie, and get a fun,
AI-generated fact about it — cached for 60 seconds and protected against
duplicate concurrent generations.

**Stack:** TypeScript, Next.js (App Router), React, Tailwind CSS, PostgreSQL,
Prisma, NextAuth.js (Google OAuth), OpenAI API, pino (structured logs),
Vitest.

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
- Docker (for the integration tests, and the easiest way to get a local dev
  database — see below)

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
| `DATABASE_POOL_MAX` | Optional, max Postgres connections per server instance (default 5) |
| `LOG_LEVEL` | Optional, structured-log level (default `info`) |

**Google OAuth setup:**

1. Go to [Google Cloud Console → APIs & Credentials](https://console.cloud.google.com/apis/credentials).
2. Create an OAuth 2.0 Client ID (Web application).
3. Add authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
   (and your production URL's equivalent later).
4. Copy the Client ID / Secret into `.env`.

None of these secrets are ever sent to the browser — they're only read in
server-side code (`route.ts` handlers, server components, server actions).

### Local database (optional)

If you don't have Postgres running, start one on port 5432 that matches the
`DATABASE_URL` example above (`docker-compose.yml` is only the throwaway test
database on port 5433, not this one):

```bash
docker run -d --name movie-memory-dev-db \
  -e POSTGRES_USER=movie_memory -e POSTGRES_PASSWORD=<your password> \
  -e POSTGRES_DB=movie_memory -p 5432:5432 \
  -v movie-memory-dev-data:/var/lib/postgresql/data postgres:16-alpine
```

Use the same user, password and database name in `DATABASE_URL`. Without a
reachable database, sign-in fails with an Auth.js `AdapterError` on the first
session lookup.

### Database migration

```bash
npx prisma migrate dev      # development: applies migrations, generates the client
npx prisma migrate deploy   # production / CI: applies existing migrations only
```

This applies the migrations in `prisma/migrations/` and generates the Prisma
Client. Tables: `User`, `Account`, `Session`, `VerificationToken`, `Fact`,
`RateLimit`. To browse the data locally, run `npx prisma studio`.

### Run

```bash
npm run dev
```

Visit `http://localhost:3000`.

### Tests

```bash
npm test                  # fast unit tests — mocked Prisma/OpenAI, no services needed
npm run db:test:up        # start a throwaway Postgres in Docker (port 5433)
npm run test:integration  # real Postgres + real Prisma, only OpenAI mocked
npm run db:test:down      # stop it and delete its data
```

**Unit tests** cover the cache window, the lock guard, retry/backoff timing,
failure fallback, movie-aware caching, retention, rate limiting, log
redaction, polling and authorization on `/api/fact`.

**Integration tests** run against a real Postgres (migrated with the real
migration files) and prove the concurrency claims instead of assuming them —
see [Concurrency: what the integration tests prove](#concurrency-what-the-integration-tests-prove).
They refuse to run against any database whose name doesn't contain `test`.
A GitHub Actions workflow (`.github/workflows/ci.yml`) runs lint, type-check,
unit and integration tests against a Postgres service on every push and PR.

---

## 2. Architecture overview

### Auth flow

NextAuth.js (v5) with the Prisma adapter and Google as the only provider.
Sessions use the **database** strategy (not JWT): the browser holds only an
opaque session-token cookie, and every `auth()` call looks it up in Postgres.
The trade-off: a database read per request, in exchange for server-side
revocation (delete the row and the session is gone immediately, which a
signed JWT can't do before it expires).

Session lifetime is the Auth.js default, not configured here: a session
expires after **30 days idle**, and any request at most once every 24 hours
pushes the expiry out another 30 days (`maxAge` / `updateAge` in the
`session` option of `src/lib/auth.ts` change this). Google's own access and
refresh tokens sit in the `Account` table but don't affect the app's session,
since Google is only used to identify the user at sign-in.

Routing logic lives in the pages themselves rather than in Next.js's
`proxy.ts` (called `middleware.ts` before Next 16):

- `/` (landing): if signed in, reads `favoriteMovie` and redirects to
  `/onboarding` or `/dashboard`; if signed out, renders the sign-in button.
- `/onboarding`: redirects to `/` if signed out, redirects to `/dashboard` if
  already onboarded, otherwise renders the form.
- `/dashboard`: redirects to `/` if signed out, redirects to `/onboarding` if
  no favorite movie is set yet.

Why not Proxy: it defaults to the Node.js runtime in Next 16, so the old
"Prisma can't run on the Edge" argument no longer applies. The reason now is
what the Next docs recommend — Proxy is meant for optimistic, cheap checks,
not for slow data fetching or as the only authorization layer. Every
protected page and route independently checks `auth()` itself, so a request
can't reach protected data just because it skipped a matcher.

### Data model

```
User
 ├─ id, name, email, image           (from Google, via the adapter)
 ├─ favoriteMovie   String?          (set in onboarding, editable on the dashboard)
 ├─ generationStartedAt DateTime?    (nullable lock, see below)
 └─ facts  Fact[]

Fact
 ├─ id, userId, content, createdAt
 └─ movie String?                    (the normalized movie this fact is about)

RateLimit
 └─ key (PK), count, expiresAt       (one row per rate-limit key per window)
```

`favoriteMovie` and `generationStartedAt` live on `User` rather than `Fact`
because they describe the *next* generation, which by definition doesn't
have a `Fact` row yet — there's exactly one favorite movie and one
in-flight-generation state per user, not per fact.

### API

`/api/fact` returns an explicit `status` in every response (`fresh`,
`generated`, `in_progress`, `error`, plus `no_movie` and `rate_limited`), so
the client never has to infer meaning from HTTP codes or message text. The
wire types are shared in `src/lib/factApi.ts`.

- `POST /api/fact` — get a fact for the signed-in user's current movie
  (cached, or generated under the lock). Rate limited.
- `GET /api/fact` — a **pure read**: the latest fact for the current movie
  plus whether a generation is in flight. It never generates, so it is safe to
  poll. The dashboard uses it to wait for an in-flight generation
  (1s, then 2s × 4, ~5 tries) instead of asking the user to click again, and
  cancels polling if the component unmounts.

Both are always scoped to `session.user.id`; there is no user id in the
request, so there's no way to read or write another user's data.

### Fact generation: cache + lock (`src/lib/factService.ts`)

`getOrGenerateFact(userId)` is called from `POST /api/fact` (which does
nothing but authenticate, rate limit, and map the result to a response — all
real logic is in the service function so it's testable without a server):

1. Load the user's `favoriteMovie` (normalized: trimmed, whitespace
   collapsed). If unset, return `no_movie` (400).
2. Load the most recent `Fact` **for that movie** (case-insensitive).
3. If it exists and is **< 60s old**, return it — no OpenAI call.
4. Otherwise, try to **atomically acquire the generation lock**:
   ```ts
   prisma.user.updateMany({
     where: {
       id: userId,
       OR: [{ generationStartedAt: null }, { generationStartedAt: { lt: staleBefore } }],
     },
     data: { generationStartedAt: lockedAt },
   });
   ```
   If `count === 1`, this request won the lock and proceeds. If `count === 0`,
   someone else already holds a fresh lock — return the most recent cached
   fact (even if stale) instead of calling OpenAI again.
5. **Re-read the latest fact now that we hold the lock.** Another request may
   have finished generating between our first read and winning the lock; if a
   fresh fact now exists, return it and skip OpenAI. (Without this, that
   request would produce a second fact inside the same 60s window.)
6. Call OpenAI. If the user edited their movie meanwhile, discard the result
   instead of storing/returning a fact about the old film.
7. Save the new `Fact`, prune old ones (see retention), return it.
8. On failure (timeout/error): log it, then fall back to the last cached fact
   for the current movie if one exists, otherwise return a clean
   `{ status: "error", error: "..." }` (never a raw stack trace).
9. In a `finally`, **release only our own lock**: the release is
   `updateMany({ where: { id, generationStartedAt: lockedAt } })`, so if our
   lock had gone stale and another request took over, we don't wipe their
   lock. A failed release is logged and swallowed — it must not turn a saved
   fact into a 500, and the stale-lock timeout recovers on its own.

A stale lock (`generationStartedAt` older than 15s) is treated as abandoned,
so a crashed request can't permanently wedge future generations for that
user.

### Timing invariant: generation must finish before the lock can go stale

If an OpenAI call could outlive `LOCK_STALE_MS`, a second request would see
the lock as abandoned, take it, and fire a duplicate call while the first is
still running — exactly what the lock exists to prevent. The OpenAI SDK's own
defaults break this: it retries twice, each attempt gets a full timeout, and
it honors `Retry-After` for up to 60s, so a struggling call can take 30s+.

So the SDK's retries are turned off (`maxRetries: 0`) and
`src/lib/retry.ts` retries transient errors itself — connection errors and
timeouts, 408, 409, 429, 5xx; **never** 400/401 or other permanent errors —
with exponential backoff and jitter, under one total budget. That budget,
`GENERATION_BUDGET_MS`, is derived in `factService.ts` as
`LOCK_STALE_MS - 5s`, so it is shorter than the stale window by construction,
and a unit test asserts it. Each attempt's timeout shrinks to the budget
remaining, so the last retry cannot overrun the deadline.

### Editable favorite movie

Users can change their movie from the dashboard (`updateFavoriteMovie`
server action, reusing `validateMovieTitle`). The design point: each `Fact`
records the movie it was generated for, and the cache **and** the failure
fallback only consider facts whose movie matches the user's *current*
favorite. Changing the movie therefore invalidates old facts automatically —
a fact about the wrong film can never be shown, even as a fallback — and it
also covers an edit that lands while a generation is mid-flight (that result
is discarded). The edit clears an in-flight lock so the new movie isn't
blocked behind an obsolete generation; because lock release is scoped to the
holder's own timestamp, the old request can't clear the new holder's lock.
Titles are normalized (trim + collapse whitespace) and compared
case-insensitively. The migration backfills `Fact.movie` from the user's
movie, which was write-once until this change.

### Rate limiting (`src/lib/rateLimit.ts`)

`rateLimit(key, limit, windowMs)` is called from the route after auth and
before the service (POST: 10/min per user; the polling GET has its own 60/min).
Over the limit returns `429` with a `Retry-After` header.

It is a fixed-window counter in Postgres, incremented with one atomic
`INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count` —
the same trick as the generation lock. The database serializes concurrent
increments, so the count is exact across any number of instances.

- *Why not in-memory:* it only counts what one process sees, so N instances
  would allow N× the limit.
- *Why not Redis:* better at scale, but harder for a reviewer to run. The
  function is the only seam, so moving to Redis is a one-file change
  (`INCR` + `EXPIRE`).
- It **fails open** if its own database call errors (the app needs that same
  database to do anything anyway), and expired rows are purged
  opportunistically without ever affecting the allow/deny decision.

### Logging (`src/lib/logger.ts`)

JSON logs via pino, one object per line, each with an `event` field:
`cache_hit`, `lock_acquired`, `lock_contended`, `fact_generated`,
`openai_error`, `openai_retry`, `lock_release_failed`, `rate_limited`, … with
`userId`, `durationMs`, and for errors the HTTP `errorStatus` and message.
Never logged: emails, tokens, API keys. Error messages are scrubbed
(`sk-…` keys and bearer tokens are redacted — OpenAI's own 401 message echoes
a partially masked key) and the raw error object is never logged.

### Retention and connection pool

Only the newest 20 facts per user are kept (best-effort prune after each
generation). The Prisma connection pool is explicit (`src/lib/dbPool.ts`,
default 5 per instance, `DATABASE_POOL_MAX`) because every instance opens its
own pool: instances × pool size must stay under Postgres's `max_connections`.
Past a handful of instances, put a pooler (PgBouncer, or your host's pooled
connection string) in front and point `DATABASE_URL` at it rather than
raising the number.

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

### Concurrency: what the integration tests prove

The unit tests mock Prisma, so they can only show the *branching* is right.
`src/lib/*.integration.test.ts` run against a real Postgres to show the
guarantees hold:

- 20 simultaneous requests → OpenAI is called **exactly once**, exactly one
  `Fact` row exists, and exactly one request reports `generated`.
- 36 requests staggered around a 300ms generation (so some read state just
  before the winner saves and try the lock just after it releases) → still
  one call, one fact. A deterministic test forces the exact read-then-lock
  race and shows the post-lock re-check closes it.
- A fresh foreign lock blocks; a stale lock is taken over; a request only
  releases its own lock even if another took over mid-flight.
- Editing the movie never surfaces an old-movie fact (cache or fallback).
- Retention keeps exactly the newest 20 facts.
- The rate limiter counts exactly under concurrency: 15 simultaneous calls
  with a limit of 5 → exactly 5 allowed.

**These tests were checked by breaking the code on purpose.** A passing test
proves little if it would also pass on broken code, so each guarantee was
verified by mutation — with the safeguard removed, exactly the intended test
fails:

| Deliberate break | Test that catches it |
|---|---|
| Lock acquired with a naive read-then-write instead of one atomic `UPDATE` | the 20-simultaneous-requests test |
| Post-lock re-check removed | the deterministic race-window test |
| Lock released unconditionally instead of only if still ours | the "only releases its OWN lock" test |

Two things this turned up, worth knowing when extending the tests:

- The concurrency test must open its database connections *first*
  (`warmPool`). The pool connects lazily, so otherwise the "simultaneous"
  requests are staggered by connection setup, early ones finish locking before
  late ones start, and even the naive non-atomic lock passes. (The first
  version of the test had exactly this weakness.)
- The random-timing tests (20 simultaneous, 36 staggered) do **not** reliably
  hit the tiny read-then-lock window, so removing the re-check went unnoticed
  by them. Only the deterministic test, which forces that exact interleaving,
  guards it.

---

## 4. Scaling path (deliberately not built)

Redis, queues and read replicas were left out on purpose: in a take-home they
add setup burden and risk, and a reviewer can't easily run them. Each has a
seam where it would plug in:

| When you need it | What | The seam |
|---|---|---|
| Many instances, high request rate | **Redis** for rate limiting | Reimplement `rateLimit()` in `src/lib/rateLimit.ts` (`INCR` + `EXPIRE`); callers don't change |
| Generation should not tie up a request for up to 10s | **Background queue** + worker | The POST/GET split: POST enqueues and returns `in_progress`, a worker generates, the client already polls the side-effect-free GET |
| Lock contention or a hot user row | **Redis / advisory lock** for the generation lock | The lock is two small functions in `factService.ts` (acquire `updateMany`, `releaseLock`) |
| Read-heavy dashboard traffic | **Read replica** | Reads go through `prisma`; `getLatestFact`/`peekFact` are the read paths to point at a replica |
| Hundreds of instances | **Connection pooler** | `DATABASE_URL` → PgBouncer/hosted pooler; pool sizing in `src/lib/dbPool.ts` |

---

## 5. What I'd improve with 2 more hours

- **Per-request `Retry-After` from OpenAI** is ignored (we use our own
  backoff under a hard budget so the lock invariant holds). Honoring it when
  it fits inside the budget would be politer to a rate-limiting API.
- **Log shipping and metrics**: logs are structured but only go to stdout;
  counters for cache-hit ratio, lock contention and OpenAI latency would come
  next.
- **Component/E2E tests** for the dashboard (the polling logic is unit tested
  as a plain function, but there's no browser-level test of `FactCard`).
- **Integration tests for the auth flow** (the Google OAuth round trip is
  exercised only by hand).
- **Fixed-window rate limiting** allows a burst at a window boundary (up to
  2× the limit across two adjacent windows); a sliding window or token bucket
  would smooth that.

## Known limitations

- OpenAI-generated facts are not fact-checked by this app; treat them as
  "fun," not "verified."
- The favorite movie is a free-text field with only length validation — no
  attempt is made to verify it's a real movie title.
- If the user edits their movie while a generation is in flight, that request
  returns `in_progress` with no fact and the client stops polling after ~5
  tries; clicking the button again generates for the new movie.
