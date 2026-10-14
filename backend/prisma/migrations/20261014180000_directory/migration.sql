-- V2.7.2 Artist directory facts per artist (Admin Studio export): songs, followers, verified, core member, research. Additive.
ALTER TABLE "artist_cases" ADD COLUMN "directory" JSONB;
