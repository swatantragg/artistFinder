-- AlterTable
ALTER TABLE "artist_cases" ADD COLUMN     "discoveryStatus" TEXT NOT NULL DEFAULT 'Not started',
ADD COLUMN     "discoveryUpdatedAt" TEXT,
ADD COLUMN     "verifiedProfileCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "routes" ADD COLUMN     "path" JSONB,
ADD COLUMN     "pathId" TEXT;

-- CreateTable
CREATE TABLE "collaborators" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "caseId" TEXT,
    "status" TEXT NOT NULL,
    "roles" TEXT[],
    "songs" TEXT[],
    "firstJobId" TEXT NOT NULL,
    "lastJobId" TEXT NOT NULL,
    "firstSeenAt" TEXT NOT NULL,
    "lastSeenAt" TEXT NOT NULL,

    CONSTRAINT "collaborators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artist_profiles" (
    "id" TEXT NOT NULL,
    "caseId" TEXT,
    "collaboratorId" TEXT,
    "platform" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "username" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "location" TEXT,
    "language" TEXT,
    "links" TEXT[],
    "tracks" JSONB NOT NULL,
    "followers" INTEGER,
    "source" TEXT NOT NULL,
    "foundVia" JSONB NOT NULL,
    "discoveryStatus" TEXT NOT NULL,
    "verificationStatus" TEXT NOT NULL,
    "evidenceScore" INTEGER NOT NULL,
    "strength" TEXT NOT NULL,
    "matched" TEXT[],
    "conflicts" TEXT[],
    "matchedSongs" TEXT[],
    "otherCaseId" TEXT,
    "groupKey" TEXT,
    "groupLabel" TEXT,
    "changeOfProfileId" TEXT,
    "scoreAtReview" INTEGER,
    "firstJobId" TEXT NOT NULL,
    "lastJobId" TEXT NOT NULL,
    "lastVersion" INTEGER NOT NULL,
    "discoveredAt" TEXT NOT NULL,
    "lastCheckedAt" TEXT NOT NULL,
    "reviewedAt" TEXT,
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "verifiedAt" TEXT,
    "verifiedBy" TEXT,
    "rejectionReason" TEXT,
    "demo" BOOLEAN NOT NULL,

    CONSTRAINT "artist_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verified_profiles" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "profileId" TEXT,
    "platform" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "username" TEXT,
    "displayName" TEXT NOT NULL,
    "verificationStatus" TEXT NOT NULL,
    "verifiedBy" TEXT NOT NULL,
    "verifiedAt" TEXT NOT NULL,
    "lastCheckedAt" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "replacedBy" TEXT,

    CONSTRAINT "verified_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_jobs" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "focus" TEXT[],
    "focusTrackIds" TEXT[],
    "bulkId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "demo" BOOLEAN NOT NULL,
    "step" INTEGER NOT NULL,
    "steps" JSONB NOT NULL,
    "providers" JSONB NOT NULL,
    "queryCount" INTEGER NOT NULL,
    "cachedCount" INTEGER NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "profileCount" INTEGER NOT NULL,
    "newProfileCount" INTEGER NOT NULL,
    "groupCount" INTEGER NOT NULL,
    "pathCount" INTEGER NOT NULL,
    "outcome" TEXT,
    "failureReason" TEXT,
    "attempt" INTEGER NOT NULL,
    "retryOf" TEXT,
    "createdAt" TEXT NOT NULL,
    "startedAt" TEXT,
    "finishedAt" TEXT,
    "durationMs" INTEGER,

    CONSTRAINT "discovery_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_queries" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "error" TEXT,
    "ranAt" TEXT NOT NULL,

    CONSTRAINT "discovery_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_results" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "displayName" TEXT,
    "username" TEXT,
    "structured" JSONB,
    "profileId" TEXT,
    "demo" BOOLEAN NOT NULL,
    "discoveredAt" TEXT NOT NULL,

    CONSTRAINT "discovery_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_evidence" (
    "id" TEXT NOT NULL,
    "caseId" TEXT,
    "profileId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "polarity" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "sourceUrl" TEXT,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "discovery_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "graph_nodes" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "refId" TEXT,
    "sub" TEXT,
    "url" TEXT,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "graph_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "graph_edges" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "confidence" INTEGER NOT NULL,
    "discoveredAt" TEXT NOT NULL,
    "verifiedAt" TEXT,
    "verifiedBy" TEXT,

    CONSTRAINT "graph_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection_paths" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetContactId" TEXT,
    "targetProfileId" TEXT,
    "edgeCount" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "strength" TEXT NOT NULL,
    "evidence" TEXT[],
    "status" TEXT NOT NULL,
    "routeId" TEXT,
    "foundAt" TEXT NOT NULL,
    "lastFoundAt" TEXT NOT NULL,
    "foundBy" TEXT NOT NULL,
    "decidedAt" TEXT,
    "decidedBy" TEXT,
    "reason" TEXT,
    "note" TEXT,

    CONSTRAINT "connection_paths_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "collaborators_key_key" ON "collaborators"("key");

-- CreateIndex
CREATE INDEX "artist_profiles_caseId_idx" ON "artist_profiles"("caseId");

-- CreateIndex
CREATE INDEX "artist_profiles_normalizedUrl_idx" ON "artist_profiles"("normalizedUrl");

-- CreateIndex
CREATE INDEX "verified_profiles_caseId_idx" ON "verified_profiles"("caseId");

-- CreateIndex
CREATE INDEX "discovery_jobs_caseId_idx" ON "discovery_jobs"("caseId");

-- CreateIndex
CREATE INDEX "discovery_jobs_status_idx" ON "discovery_jobs"("status");

-- CreateIndex
CREATE INDEX "discovery_jobs_bulkId_idx" ON "discovery_jobs"("bulkId");

-- CreateIndex
CREATE INDEX "discovery_queries_jobId_idx" ON "discovery_queries"("jobId");

-- CreateIndex
CREATE INDEX "discovery_queries_cacheKey_idx" ON "discovery_queries"("cacheKey");

-- CreateIndex
CREATE INDEX "discovery_results_queryId_idx" ON "discovery_results"("queryId");

-- CreateIndex
CREATE INDEX "discovery_results_profileId_idx" ON "discovery_results"("profileId");

-- CreateIndex
CREATE INDEX "discovery_evidence_profileId_idx" ON "discovery_evidence"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "graph_edges_key_key" ON "graph_edges"("key");

-- CreateIndex
CREATE INDEX "graph_edges_sourceId_idx" ON "graph_edges"("sourceId");

-- CreateIndex
CREATE INDEX "graph_edges_targetId_idx" ON "graph_edges"("targetId");

-- CreateIndex
CREATE INDEX "connection_paths_caseId_idx" ON "connection_paths"("caseId");

-- CreateIndex
CREATE INDEX "artist_cases_discoveryStatus_idx" ON "artist_cases"("discoveryStatus");

-- AddForeignKey
ALTER TABLE "artist_profiles" ADD CONSTRAINT "artist_profiles_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "artist_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verified_profiles" ADD CONSTRAINT "verified_profiles_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "artist_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

