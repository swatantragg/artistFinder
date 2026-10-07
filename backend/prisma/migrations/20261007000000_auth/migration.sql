-- Accounts and sessions for sign-up / sign-in (additive).
CREATE TABLE "auth_accounts" (
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    "lastLoginAt" TEXT,
    CONSTRAINT "auth_accounts_pkey" PRIMARY KEY ("userId")
);
CREATE UNIQUE INDEX "auth_accounts_email_key" ON "auth_accounts"("email");

CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    "expiresAt" TEXT NOT NULL,
    "userAgent" TEXT,
    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "auth_sessions_userId_idx" ON "auth_sessions"("userId");
