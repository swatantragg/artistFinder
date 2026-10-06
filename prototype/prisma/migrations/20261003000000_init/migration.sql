-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artist_cases" (
    "id" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "aliases" TEXT[],
    "backendProfileIds" TEXT[],
    "profileUrls" TEXT[],
    "roles" TEXT[],
    "language" TEXT,
    "identityStatus" TEXT NOT NULL,
    "identityEvidence" TEXT,
    "lifecycleStage" TEXT NOT NULL,
    "workReason" TEXT NOT NULL,
    "contactPreference" TEXT NOT NULL,
    "contactPreferenceUntil" TEXT,
    "previousStage" TEXT,
    "stageReason" TEXT NOT NULL,
    "stageSince" TEXT NOT NULL,
    "ownerId" TEXT,
    "nextAction" TEXT,
    "nextActionDate" TEXT,
    "firstSeen" TEXT NOT NULL,
    "lastSeen" TEXT NOT NULL,
    "lastEvidenceChange" TEXT,
    "lastEvidenceNote" TEXT,
    "firstSeenBatchId" TEXT,
    "lastSeenBatchId" TEXT,
    "claimStatus" TEXT NOT NULL,
    "activationStatus" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "priorityScore" INTEGER NOT NULL,
    "mergedIntoId" TEXT,
    "closedReason" TEXT,
    "waiting" JSONB,
    "checklist" JSONB NOT NULL,
    "arm" JSONB,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,

    CONSTRAINT "artist_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "exportDate" TEXT NOT NULL,
    "uploadDate" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "importType" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "versionOfId" TEXT,
    "repeatOfId" TEXT,
    "rowCount" INTEGER NOT NULL,
    "acceptedCount" INTEGER NOT NULL,
    "quarantinedCount" INTEGER NOT NULL,
    "skippedCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB,
    "status" TEXT NOT NULL,
    "classification" TEXT,
    "reason" TEXT,
    "ownerId" TEXT,
    "exceptionStatus" TEXT,
    "resolution" TEXT,
    "resolvedAt" TEXT,
    "caseIds" TEXT[],
    "trackId" TEXT,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "releases" (
    "id" TEXT NOT NULL,
    "backendReleaseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "firstSeen" TEXT NOT NULL,

    CONSTRAINT "releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracks" (
    "id" TEXT NOT NULL,
    "backendTrackId" TEXT NOT NULL,
    "releaseId" TEXT,
    "title" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "isrc" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "distributor" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "releaseDate" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "flags" TEXT[],
    "sig" TEXT NOT NULL,
    "firstSeen" TEXT NOT NULL,
    "lastSeen" TEXT NOT NULL,
    "firstBatchId" TEXT NOT NULL,
    "lastBatchId" TEXT NOT NULL,
    "history" JSONB NOT NULL,

    CONSTRAINT "tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credits" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "caseId" TEXT,
    "personName" TEXT NOT NULL,
    "personBackendId" TEXT,
    "role" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "firstSeen" TEXT NOT NULL,
    "lastSeen" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "statusReason" TEXT,

    CONSTRAINT "credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_conflicts" (
    "id" TEXT NOT NULL,
    "caseIds" TEXT[],
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "decisionId" TEXT,

    CONSTRAINT "identity_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_decisions" (
    "id" TEXT NOT NULL,
    "conflictId" TEXT NOT NULL,
    "caseIds" TEXT[],
    "decision" TEXT NOT NULL,
    "canonicalId" TEXT,
    "reviewerId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "added" JSONB,
    "snapshot" JSONB,
    "reversedAt" TEXT,
    "reversedBy" TEXT,
    "reverseReason" TEXT,

    CONSTRAINT "identity_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "personName" TEXT NOT NULL,
    "caseId" TEXT,
    "organisation" TEXT,
    "role" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "authorityEvidence" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "verifiedById" TEXT,
    "verifiedAt" TEXT,
    "willingIntroducer" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routes" (
    "id" TEXT NOT NULL,
    "targetCaseId" TEXT NOT NULL,
    "trackId" TEXT,
    "collaboratorName" TEXT,
    "collaboratorCaseId" TEXT,
    "organisation" TEXT,
    "contactId" TEXT,
    "sourceUrl" TEXT,
    "evidence" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "ranking" INTEGER NOT NULL,
    "lastChecked" TEXT,
    "rejectionReason" TEXT,
    "ownerId" TEXT,
    "origin" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_activities" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "researcherId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "checklistStep" INTEGER,

    CONSTRAINT "research_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_attempts" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "routeId" TEXT,
    "date" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "nextAction" TEXT NOT NULL,
    "nextActionDate" TEXT,
    "ownerId" TEXT NOT NULL,

    CONSTRAINT "contact_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "ownerId" TEXT,
    "kind" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "why" TEXT NOT NULL,
    "evidenceChange" TEXT,
    "dueDate" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "workReason" TEXT NOT NULL,
    "action" TEXT,
    "channel" TEXT,
    "recipient" TEXT,
    "result" TEXT,
    "evidence" TEXT[],
    "notes" JSONB NOT NULL,
    "nextAction" TEXT,
    "focusedMinutes" INTEGER NOT NULL,
    "createdAt" TEXT NOT NULL,
    "startedAt" TEXT,
    "completedAt" TEXT,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_events" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "profileId" TEXT,
    "claimRequestId" TEXT,
    "recipient" TEXT,
    "reviewerId" TEXT,
    "notes" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "claim_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activation_events" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "feature" TEXT,
    "expectedOutcome" TEXT,
    "operatorId" TEXT,
    "agreedDate" TEXT,
    "backendRef" TEXT,
    "evidence" TEXT NOT NULL,
    "result" TEXT,
    "actorId" TEXT NOT NULL,

    CONSTRAINT "activation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reopen_events" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "oldStage" TEXT NOT NULL,
    "newStage" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "why" TEXT NOT NULL,
    "routeId" TEXT,
    "taskId" TEXT,
    "batchId" TEXT,
    "contactId" TEXT,
    "ownerId" TEXT,

    CONSTRAINT "reopen_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "at" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "caseId" TEXT,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "field" TEXT,
    "from" TEXT,
    "to" TEXT,
    "reason" TEXT,
    "evidence" TEXT,
    "result" TEXT,
    "next" TEXT,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "caseId" TEXT,
    "at" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta" (
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "meta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "artist_cases_lifecycleStage_idx" ON "artist_cases"("lifecycleStage");

-- CreateIndex
CREATE INDEX "artist_cases_ownerId_idx" ON "artist_cases"("ownerId");

-- CreateIndex
CREATE INDEX "import_batches_checksum_idx" ON "import_batches"("checksum");

-- CreateIndex
CREATE INDEX "import_rows_batchId_idx" ON "import_rows"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "releases_backendReleaseId_key" ON "releases"("backendReleaseId");

-- CreateIndex
CREATE UNIQUE INDEX "tracks_backendTrackId_key" ON "tracks"("backendTrackId");

-- CreateIndex
CREATE INDEX "tracks_isrc_idx" ON "tracks"("isrc");

-- CreateIndex
CREATE INDEX "credits_trackId_idx" ON "credits"("trackId");

-- CreateIndex
CREATE INDEX "credits_caseId_idx" ON "credits"("caseId");

-- CreateIndex
CREATE INDEX "routes_targetCaseId_idx" ON "routes"("targetCaseId");

-- CreateIndex
CREATE INDEX "research_activities_caseId_idx" ON "research_activities"("caseId");

-- CreateIndex
CREATE INDEX "contact_attempts_caseId_idx" ON "contact_attempts"("caseId");

-- CreateIndex
CREATE INDEX "tasks_caseId_idx" ON "tasks"("caseId");

-- CreateIndex
CREATE INDEX "tasks_ownerId_status_idx" ON "tasks"("ownerId", "status");

-- CreateIndex
CREATE INDEX "claim_events_caseId_idx" ON "claim_events"("caseId");

-- CreateIndex
CREATE INDEX "activation_events_caseId_idx" ON "activation_events"("caseId");

-- CreateIndex
CREATE INDEX "reopen_events_caseId_idx" ON "reopen_events"("caseId");

-- CreateIndex
CREATE INDEX "audit_events_caseId_idx" ON "audit_events"("caseId");

-- CreateIndex
CREATE INDEX "audit_events_at_idx" ON "audit_events"("at");

-- AddForeignKey
ALTER TABLE "artist_cases" ADD CONSTRAINT "artist_cases_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "import_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credits" ADD CONSTRAINT "credits_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credits" ADD CONSTRAINT "credits_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "artist_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "artist_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_targetCaseId_fkey" FOREIGN KEY ("targetCaseId") REFERENCES "artist_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "tracks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_activities" ADD CONSTRAINT "research_activities_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "artist_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_attempts" ADD CONSTRAINT "contact_attempts_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "artist_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "artist_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "artist_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activation_events" ADD CONSTRAINT "activation_events_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "artist_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reopen_events" ADD CONSTRAINT "reopen_events_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "artist_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

