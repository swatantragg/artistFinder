-- V2.5.0 storage clean-up (asked for by the owner: the free database was full).
-- 1. The catalogue part of the graph (song ↔ artist, release, label, distributor: ~348,000 edges and ~86,000 nodes, 40% of
--    the database) repeats what tracks, credits and releases already hold. The app rebuilds it in memory when it loads,
--    and only for the top 250 artists with their closest connections (owner's choice), so the stored copies go.
--    Edges and nodes decided by people (profiles, contacts, routes, relationships) stay.
-- 2. Track signatures (used to skip unchanged rows on re-import) become the SHA-256 of the same text: 64 characters instead
--    of ~440. The app computes the same hash, so unchanged rows are still recognised.
-- The space is given back once by the app (VACUUM FULL), because VACUUM cannot run inside a migration.
DELETE FROM "graph_edges" WHERE "type" IN ('ARTIST_PERFORMED_SONG', 'ARTIST_COMPOSED_SONG', 'ARTIST_PRODUCED_SONG', 'PERSON_CREDITED_ON_SONG', 'SONG_ON_RELEASE', 'SONG_RELEASED_ON_LABEL', 'SONG_DISTRIBUTED_BY');
DELETE FROM "graph_nodes" WHERE "type" IN ('Song', 'Release', 'Artist', 'Person', 'Label', 'Distributor');
UPDATE "tracks" SET "sig" = encode(sha256(convert_to("sig", 'UTF8')), 'hex') WHERE length("sig") <> 64;
