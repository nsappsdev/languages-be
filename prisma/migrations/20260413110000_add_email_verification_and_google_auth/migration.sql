-- Make passwordHash and salt nullable (Google users have no password)
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
ALTER TABLE "User" ALTER COLUMN "salt" DROP NOT NULL;

-- Add auth provider tracking
ALTER TABLE "User" ADD COLUMN "authProvider" TEXT NOT NULL DEFAULT 'email';

-- Add Google OAuth
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- Add email verification
ALTER TABLE "User" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "emailVerificationToken" TEXT;
ALTER TABLE "User" ADD COLUMN "emailVerificationExpiresAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "User_emailVerificationToken_key" ON "User"("emailVerificationToken");

-- Mark all existing users as verified (they were created before verification existed)
UPDATE "User" SET "emailVerified" = true;
