# AI Usage Notes

- Claude Code (Sonnet 5) was used as a pair-programmer for the full build: scaffolding the Next.js project, writing the Prisma schema, NextAuth config, pages, the fact-generation endpoint, and the Vitest test suite.
- The Prisma schema was reviewed manually (in conversation) before running any migration, per the requested workflow — no migration was generated against an unreviewed schema.
- The 60-second cache + Postgres-backed generation lock design (Variant A) was implemented and explained in-line as code comments and in the README, so the reasoning (atomic conditional `UPDATE ... WHERE` as the lock-acquisition primitive) could be checked rather than taken on faith.
- All OpenAI-generated "fun facts" produced by the running app are model output and are not fact-checked by this codebase — see the "Known limitations" note in the README.
- No AI-generated code was committed without being read; package versions and library APIs (NextAuth v5, Prisma 7) were verified against what actually installed, not assumed from training data.
