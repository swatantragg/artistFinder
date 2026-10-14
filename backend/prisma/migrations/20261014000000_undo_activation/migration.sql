-- V2.7.0 Activation steps can be undone too (they continue the claim). Additive.
ALTER TABLE "activation_events" ADD COLUMN "undoneAt" TEXT, ADD COLUMN "undoneBy" TEXT, ADD COLUMN "undoReason" TEXT;
