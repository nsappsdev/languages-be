ALTER TABLE "SentenceAudio" ADD COLUMN "normalizedAlignment" JSONB NOT NULL DEFAULT 'null';

CREATE TABLE "AudioTiming" (
  "id" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "textSha256" TEXT NOT NULL,
  "algorithmVersion" INTEGER NOT NULL,
  "status" "TextAlignmentStatus" NOT NULL,
  "mapping" JSONB NOT NULL,
  "providerAlignment" JSONB NOT NULL DEFAULT 'null',
  "repairStatus" TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
  "repairError" TEXT,
  "ownerJobId" TEXT,
  "attemptedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AudioTiming_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AudioTiming_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "AudioAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AudioTiming_assetId_textSha256_algorithmVersion_key"
  ON "AudioTiming"("assetId", "textSha256", "algorithmVersion");
