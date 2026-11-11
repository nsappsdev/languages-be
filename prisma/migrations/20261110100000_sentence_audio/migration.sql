ALTER TYPE "AudioAssetKind" ADD VALUE 'SENTENCE';

CREATE TABLE "SentenceAudio" (
    "id" TEXT NOT NULL,
    "textId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "ownerJobId" TEXT NOT NULL,
    "status" "AudioJobStatus" NOT NULL DEFAULT 'RUNNING',
    "assetId" TEXT,
    "rawAlignment" JSONB NOT NULL DEFAULT 'null',
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SentenceAudio_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SentenceAudio_textId_fkey" FOREIGN KEY ("textId") REFERENCES "TextWorkspace"("textId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SentenceAudio_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "AudioAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SentenceAudio_textId_requestHash_key" ON "SentenceAudio"("textId", "requestHash");
CREATE INDEX "SentenceAudio_ownerJobId_status_idx" ON "SentenceAudio"("ownerJobId", "status");
