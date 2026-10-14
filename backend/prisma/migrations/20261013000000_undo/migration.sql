-- V2.6.0 Undo and reset: a step undone by a person stays in the history, marked, and is ignored by the workflow. Additive.
ALTER TABLE "contact_attempts" ADD COLUMN "undoneAt" TEXT, ADD COLUMN "undoneBy" TEXT, ADD COLUMN "undoReason" TEXT;
ALTER TABLE "claim_events" ADD COLUMN "undoneAt" TEXT, ADD COLUMN "undoneBy" TEXT, ADD COLUMN "undoReason" TEXT;
ALTER TABLE "outreach_messages" ADD COLUMN "undoneAt" TEXT, ADD COLUMN "undoneBy" TEXT, ADD COLUMN "undoReason" TEXT;
