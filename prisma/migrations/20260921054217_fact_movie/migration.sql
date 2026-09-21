-- AlterTable
ALTER TABLE "Fact" ADD COLUMN     "movie" TEXT;

-- Backfill: favoriteMovie was write-once before this migration, so every
-- existing fact was generated for the user's current favorite movie.
UPDATE "Fact" AS f
SET "movie" = u."favoriteMovie"
FROM "User" AS u
WHERE f."userId" = u."id" AND f."movie" IS NULL;
