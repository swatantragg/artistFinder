-- V2.7.2 Is the artist alive? Result of the public-records check made by Find artist, and a person's decision. Additive.
ALTER TABLE "artist_cases" ADD COLUMN "life" JSONB;
