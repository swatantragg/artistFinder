-- V2.5.0 Messages: direct messages on verified profiles, festival greetings consent. Purely additive.
-- AlterTable
ALTER TABLE "artist_cases" ADD COLUMN     "greetings" TEXT NOT NULL DEFAULT 'Unknown';

-- CreateTable
CREATE TABLE "outreach_messages" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "followUpNo" INTEGER NOT NULL,
    "templateId" TEXT,
    "festivalId" TEXT,
    "platform" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sentAt" TEXT NOT NULL,
    "sentBy" TEXT NOT NULL,
    "attemptId" TEXT,
    "outcome" TEXT,
    "outcomeAt" TEXT,
    "outcomeBy" TEXT,

    CONSTRAINT "outreach_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outreach_messages_caseId_idx" ON "outreach_messages"("caseId");

-- CreateIndex
CREATE INDEX "outreach_messages_sentBy_sentAt_idx" ON "outreach_messages"("sentBy", "sentAt");

-- AddForeignKey
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "artist_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
