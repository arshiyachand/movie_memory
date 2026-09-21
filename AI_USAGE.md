# AI Usage Notes

## Initial build

- Claude Code (Sonnet 5) was used as a pair-programmer for the full build: scaffolding the Next.js project, writing the Prisma schema, NextAuth config, pages, the fact-generation endpoint, and the Vitest test suite.
- The Prisma schema was reviewed manually (in conversation) before running any migration, per the requested workflow — no migration was generated against an unreviewed schema.
- The 60-second cache + Postgres-backed generation lock design (Variant A) was implemented and explained in-line as code comments and in the README, so the reasoning (atomic conditional `UPDATE ... WHERE` as the lock-acquisition primitive) could be checked rather than taken on faith.
- All OpenAI-generated "fun facts" produced by the running app are model output and are not fact-checked by this codebase — see the "Known limitations" note in the README.
- No AI-generated code was committed without being read; package versions and library APIs (NextAuth v5, Prisma 7) were verified against what actually installed, not assumed from training data.

## Hardening round (retries, lock fixes, logging, editable movie, rate limiting, polling, integration tests)

The list of improvements was planned by the author; Claude Code implemented them one step at a time, each as its own commit with its own tests.

**Checked against the source rather than assumed**

- The OpenAI SDK's retry behavior was read from the installed `node_modules/openai` code: default `maxRetries = 2`, a full timeout per attempt, exponential backoff, and `Retry-After` honored for up to 60s. That confirmed a real bug: one generation could outlive the 15s lock window and allow a duplicate call. The fix (own retry loop under a single budget derived from the lock window) is unit-tested with fake timers.
- Next 16 behavior (`revalidatePath`, route-file export rules, Proxy replacing middleware and running on Node by default) was checked in the docs bundled in `node_modules/next/dist/docs`. That corrected an outdated claim in the README about why middleware isn't used.
- The Prisma adapter's accepted pool options were read from its type definitions before writing the pool config.

**Where the AI's first attempt was wrong or weak, and how it was caught**

- The first concurrency test was too weak: with the pool connecting lazily, a deliberately broken, non-atomic lock still passed it. This was found by mutation testing (breaking the code on purpose and checking the tests fail), not by reading the test. The test was fixed by opening the connections up front, then re-verified: each of three deliberate breaks (non-atomic lock, no post-lock re-check, unconditional lock release) now fails exactly the intended test. Removing the re-check is only caught by the deterministic race test, not by the random-timing ones.
- Exporting constants from a Next.js route file would have broken the production build; caught before committing and fixed.
- `tsc` caught awkward type casts in a new test, which led to loosening a function signature rather than casting.
- A test helper used `pg_sleep()`, whose `void` result Prisma can't deserialize; this looked like an implementation failure until the error was read.
- A mutation run that was stopped partway (low system memory) left a deliberately broken line in `factService.ts`. It was noticed by diffing against git and reverted before anything was committed.

**Not verified**

- The GitHub Actions workflow has not been run on GitHub yet.
- The Google sign-in round trip, onboarding, and the dashboard UI (skeleton, polling, edit control) were not exercised in a browser during this round. The polling logic is unit-tested as a plain function, but there is no browser-level test.
