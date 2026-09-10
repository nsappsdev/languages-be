-- CreateEnum
CREATE TYPE "AudioAssetKind" AS ENUM ('NARRATION', 'WORD_CLIP', 'LEGACY_REFERENCE');

-- CreateEnum
CREATE TYPE "AudioAssetState" AS ENUM ('STAGED', 'READY', 'QUARANTINED', 'DELETED');

-- CreateEnum
CREATE TYPE "TextAlignmentStatus" AS ENUM ('OK', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "OccurrenceMappingStatus" AS ENUM ('MAPPED', 'UNMAPPED');

-- CreateEnum
CREATE TYPE "AudioJobKind" AS ENUM ('GENERATE_NARRATION', 'EXTRACT_CLIPS');

-- CreateEnum
CREATE TYPE "AudioJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "TextWorkspace" (
    "textId" TEXT NOT NULL,
    "draftVersion" INTEGER NOT NULL DEFAULT 1,
    "currentContentRevisionId" TEXT,
    "currentNarrationId" TEXT,
    "currentAlignmentId" TEXT,
    "approvedTextReleaseId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TextWorkspace_pkey" PRIMARY KEY ("textId")
);

-- CreateTable
CREATE TABLE "TextContentRevision" (
    "id" TEXT NOT NULL,
    "textId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "textSha256" TEXT NOT NULL,
    "sourceLanguage" TEXT NOT NULL DEFAULT 'en',
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TextContentRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioAsset" (
    "id" TEXT NOT NULL,
    "textId" TEXT NOT NULL,
    "kind" "AudioAssetKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "sampleRate" INTEGER,
    "channels" INTEGER,
    "bitDepth" INTEGER,
    "frameCount" INTEGER,
    "state" "AudioAssetState" NOT NULL DEFAULT 'STAGED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TextNarration" (
    "id" TEXT NOT NULL,
    "textId" TEXT NOT NULL,
    "contentRevisionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "requestSettings" JSONB NOT NULL,
    "inputTextSha256" TEXT NOT NULL,
    "rawAlignment" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TextNarration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TextAlignment" (
    "id" TEXT NOT NULL,
    "textId" TEXT NOT NULL,
    "contentRevisionId" TEXT NOT NULL,
    "narrationId" TEXT NOT NULL,
    "algorithmVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "TextAlignmentStatus" NOT NULL,
    "sentences" JSONB NOT NULL,
    "diagnostics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TextAlignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WordOccurrence" (
    "id" TEXT NOT NULL,
    "alignmentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "sentenceId" TEXT NOT NULL,
    "charStart" INTEGER NOT NULL,
    "charEnd" INTEGER NOT NULL,
    "surfaceText" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "speechStartSample" INTEGER,
    "speechEndSample" INTEGER,
    "cutStartSample" INTEGER,
    "cutEndSample" INTEGER,
    "mappingStatus" "OccurrenceMappingStatus" NOT NULL,

    CONSTRAINT "WordOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TextVocabularyEntry" (
    "id" TEXT NOT NULL,
    "textId" TEXT NOT NULL,
    "alignmentId" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "TextVocabularyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TextVocabularyTranslation" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL,
    "translation" TEXT NOT NULL,
    "usageExample" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TextVocabularyTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WordClip" (
    "id" TEXT NOT NULL,
    "textId" TEXT NOT NULL,
    "narrationId" TEXT NOT NULL,
    "alignmentId" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "startSample" INTEGER NOT NULL,
    "endSample" INTEGER NOT NULL,
    "extractionVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WordClip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TextRelease" (
    "id" TEXT NOT NULL,
    "textId" TEXT NOT NULL,
    "contentRevisionId" TEXT NOT NULL,
    "narrationId" TEXT NOT NULL,
    "alignmentId" TEXT NOT NULL,
    "entryIds" JSONB NOT NULL,
    "readinessSnapshot" JSONB NOT NULL,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TextRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioJob" (
    "id" TEXT NOT NULL,
    "textId" TEXT NOT NULL,
    "kind" "AudioJobKind" NOT NULL,
    "actorId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "requestPayload" JSONB NOT NULL,
    "status" "AudioJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "resultAssetId" TEXT,
    "resultId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "reservedCharacters" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TextContentRevision_textId_sequence_key" ON "TextContentRevision"("textId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "AudioAsset_storageKey_key" ON "AudioAsset"("storageKey");

-- CreateIndex
CREATE INDEX "AudioAsset_textId_kind_idx" ON "AudioAsset"("textId", "kind");

-- CreateIndex
CREATE INDEX "TextNarration_textId_createdAt_idx" ON "TextNarration"("textId", "createdAt");

-- CreateIndex
CREATE INDEX "TextAlignment_textId_createdAt_idx" ON "TextAlignment"("textId", "createdAt");

-- CreateIndex
CREATE INDEX "WordOccurrence_alignmentId_charStart_idx" ON "WordOccurrence"("alignmentId", "charStart");

-- CreateIndex
CREATE UNIQUE INDEX "WordOccurrence_alignmentId_ordinal_key" ON "WordOccurrence"("alignmentId", "ordinal");

-- CreateIndex
CREATE INDEX "TextVocabularyEntry_textId_idx" ON "TextVocabularyEntry"("textId");

-- CreateIndex
CREATE UNIQUE INDEX "TextVocabularyEntry_alignmentId_occurrenceId_key" ON "TextVocabularyEntry"("alignmentId", "occurrenceId");

-- CreateIndex
CREATE UNIQUE INDEX "TextVocabularyTranslation_entryId_languageCode_key" ON "TextVocabularyTranslation"("entryId", "languageCode");

-- CreateIndex
CREATE INDEX "WordClip_textId_idx" ON "WordClip"("textId");

-- CreateIndex
CREATE UNIQUE INDEX "WordClip_occurrenceId_extractionVersion_key" ON "WordClip"("occurrenceId", "extractionVersion");

-- CreateIndex
CREATE INDEX "TextRelease_textId_createdAt_idx" ON "TextRelease"("textId", "createdAt");

-- CreateIndex
CREATE INDEX "AudioJob_status_createdAt_idx" ON "AudioJob"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AudioJob_textId_kind_idempotencyKey_key" ON "AudioJob"("textId", "kind", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "TextWorkspace" ADD CONSTRAINT "TextWorkspace_textId_fkey" FOREIGN KEY ("textId") REFERENCES "LessonItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextContentRevision" ADD CONSTRAINT "TextContentRevision_textId_fkey" FOREIGN KEY ("textId") REFERENCES "TextWorkspace"("textId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_textId_fkey" FOREIGN KEY ("textId") REFERENCES "TextWorkspace"("textId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextNarration" ADD CONSTRAINT "TextNarration_textId_fkey" FOREIGN KEY ("textId") REFERENCES "TextWorkspace"("textId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextNarration" ADD CONSTRAINT "TextNarration_contentRevisionId_fkey" FOREIGN KEY ("contentRevisionId") REFERENCES "TextContentRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextNarration" ADD CONSTRAINT "TextNarration_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "AudioAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextAlignment" ADD CONSTRAINT "TextAlignment_textId_fkey" FOREIGN KEY ("textId") REFERENCES "TextWorkspace"("textId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextAlignment" ADD CONSTRAINT "TextAlignment_contentRevisionId_fkey" FOREIGN KEY ("contentRevisionId") REFERENCES "TextContentRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextAlignment" ADD CONSTRAINT "TextAlignment_narrationId_fkey" FOREIGN KEY ("narrationId") REFERENCES "TextNarration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WordOccurrence" ADD CONSTRAINT "WordOccurrence_alignmentId_fkey" FOREIGN KEY ("alignmentId") REFERENCES "TextAlignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextVocabularyEntry" ADD CONSTRAINT "TextVocabularyEntry_textId_fkey" FOREIGN KEY ("textId") REFERENCES "TextWorkspace"("textId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextVocabularyEntry" ADD CONSTRAINT "TextVocabularyEntry_alignmentId_fkey" FOREIGN KEY ("alignmentId") REFERENCES "TextAlignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextVocabularyTranslation" ADD CONSTRAINT "TextVocabularyTranslation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "TextVocabularyEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WordClip" ADD CONSTRAINT "WordClip_textId_fkey" FOREIGN KEY ("textId") REFERENCES "TextWorkspace"("textId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WordClip" ADD CONSTRAINT "WordClip_narrationId_fkey" FOREIGN KEY ("narrationId") REFERENCES "TextNarration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WordClip" ADD CONSTRAINT "WordClip_alignmentId_fkey" FOREIGN KEY ("alignmentId") REFERENCES "TextAlignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WordClip" ADD CONSTRAINT "WordClip_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "TextVocabularyEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WordClip" ADD CONSTRAINT "WordClip_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "AudioAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextRelease" ADD CONSTRAINT "TextRelease_textId_fkey" FOREIGN KEY ("textId") REFERENCES "TextWorkspace"("textId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioJob" ADD CONSTRAINT "AudioJob_textId_fkey" FOREIGN KEY ("textId") REFERENCES "TextWorkspace"("textId") ON DELETE CASCADE ON UPDATE CASCADE;
