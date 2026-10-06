-- ArtistFinder v2: identity status, Goongoonalo status, artist vs collaborator, reopen reasons, status history,
-- mapped import rows. Purely additive: no column or row is removed.
-- AlterTable
ALTER TABLE "artist_cases" ADD COLUMN     "artistStatus" TEXT NOT NULL DEFAULT 'NEW',
ADD COLUMN     "artistStatusAt" TEXT,
ADD COLUMN     "firstVerifiedAt" TEXT,
ADD COLUMN     "goongoonaloStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "goongoonaloStatusAt" TEXT,
ADD COLUMN     "goongoonaloStatusBy" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'Artist',
ADD COLUMN     "manualVerifiedAt" TEXT,
ADD COLUMN     "manualVerifiedBy" TEXT,
ADD COLUMN     "rejectedAt" TEXT,
ADD COLUMN     "rejectedReason" TEXT,
ADD COLUMN     "reopen" JSONB;

-- AlterTable
ALTER TABLE "import_rows" ADD COLUMN     "mapped" JSONB;

-- CreateTable
CREATE TABLE "status_events" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "from" TEXT,
    "to" TEXT NOT NULL,
    "at" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "status_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "status_events_caseId_idx" ON "status_events"("caseId");

-- CreateIndex
CREATE INDEX "status_events_kind_to_at_idx" ON "status_events"("kind", "to", "at");

-- CreateIndex
CREATE INDEX "artist_cases_artistStatus_idx" ON "artist_cases"("artistStatus");

-- CreateIndex
CREATE INDEX "artist_cases_goongoonaloStatus_idx" ON "artist_cases"("goongoonaloStatus");

-- CreateIndex
CREATE INDEX "artist_cases_kind_idx" ON "artist_cases"("kind");

-- CreateIndex
CREATE INDEX "artist_cases_canonicalName_idx" ON "artist_cases"("canonicalName");

-- CreateIndex
CREATE INDEX "import_rows_trackId_idx" ON "import_rows"("trackId");

-- AddForeignKey
ALTER TABLE "status_events" ADD CONSTRAINT "status_events_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "artist_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Existing artists get the same classification the engine uses (it re-checks at start-up and only writes differences):
-- credited only as composer / lyricist / producer (no lead or performing credit, no backend artist ID) = Collaborator.
UPDATE "artist_cases" c SET "kind" = 'Collaborator'
WHERE cardinality(c."backendProfileIds") = 0
  AND EXISTS (SELECT 1 FROM "credits" cr WHERE cr."caseId" = c."id" AND cr."status" = 'Active')
  AND NOT EXISTS (SELECT 1 FROM "credits" cr WHERE cr."caseId" = c."id" AND cr."status" = 'Active' AND (cr."isPrimary" OR cr."role" IN ('Singer', 'Performer')));

-- A do-not-contact request is also the Goongoonalo status.
UPDATE "artist_cases" SET "goongoonaloStatus" = 'DO_NOT_CONTACT' WHERE "contactPreference" = 'Do Not Contact';

-- Identity status from what already happened (discovery result, any work started).
UPDATE "artist_cases" SET "artistStatus" = CASE
    WHEN "discoveryStatus" IN ('Queued', 'Searching') THEN 'SEARCHING'
    WHEN "discoveryStatus" = 'Needs verification' THEN 'NEEDS_REVIEW'
    WHEN "verifiedProfileCount" > 0 OR "claimStatus" = 'Completed' THEN 'VERIFIED'
    WHEN "discoveryStatus" IN ('No candidate', 'Failed') OR "lifecycleStage" NOT IN ('Unresearched', 'Identity Review') THEN 'PENDING'
    ELSE 'NEW' END,
  "artistStatusAt" = COALESCE("discoveryUpdatedAt", "updatedAt");
