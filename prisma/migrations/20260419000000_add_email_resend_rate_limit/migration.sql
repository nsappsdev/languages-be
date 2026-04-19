-- Rate-limit fields for verification email resends
ALTER TABLE "User" ADD COLUMN "emailVerificationLastSentAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "emailVerificationSendCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "emailVerificationWindowStart" TIMESTAMP(3);
