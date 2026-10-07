-- V02.4.0 account security: sign-up approval, switched-off people, two-step sign-in (TOTP), idle session expiry.
ALTER TABLE "auth_accounts" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "auth_accounts" ADD COLUMN "name" TEXT;
ALTER TABLE "auth_accounts" ADD COLUMN "mfaSecret" TEXT;
ALTER TABLE "auth_accounts" ADD COLUMN "mfaRecovery" TEXT;
ALTER TABLE "auth_accounts" ADD COLUMN "mfaLastStep" INTEGER;
ALTER TABLE "auth_sessions" ADD COLUMN "lastSeenAt" TEXT;
