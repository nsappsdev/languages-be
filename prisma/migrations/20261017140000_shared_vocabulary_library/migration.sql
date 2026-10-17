-- CreateTable
CREATE TABLE "VocabularyTerm" (
    "id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "displayText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VocabularyTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VocabularyMeaning" (
    "id" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "translation" TEXT NOT NULL,
    "normalizedTranslation" TEXT NOT NULL,

    CONSTRAINT "VocabularyMeaning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VocabularyRecording" (
    "id" TEXT NOT NULL,
    "meaningId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "narrationId" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VocabularyRecording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VocabularyUsage" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "textReleaseId" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "sentence" TEXT NOT NULL,

    CONSTRAINT "VocabularyUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VocabularyPreference" (
    "meaningId" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VocabularyPreference_pkey" PRIMARY KEY ("meaningId","voiceId")
);

-- CreateIndex
CREATE UNIQUE INDEX "VocabularyTerm_language_normalizedText_key" ON "VocabularyTerm"("language", "normalizedText");

-- CreateIndex
CREATE UNIQUE INDEX "VocabularyMeaning_termId_normalizedTranslation_key" ON "VocabularyMeaning"("termId", "normalizedTranslation");

-- CreateIndex
CREATE UNIQUE INDEX "VocabularyRecording_meaningId_assetId_key" ON "VocabularyRecording"("meaningId", "assetId");

-- CreateIndex
CREATE INDEX "VocabularyUsage_lessonId_idx" ON "VocabularyUsage"("lessonId");

-- CreateIndex
CREATE INDEX "VocabularyUsage_recordingId_idx" ON "VocabularyUsage"("recordingId");

-- CreateIndex
CREATE UNIQUE INDEX "VocabularyUsage_textReleaseId_occurrenceId_key" ON "VocabularyUsage"("textReleaseId", "occurrenceId");

-- AddForeignKey
ALTER TABLE "VocabularyMeaning" ADD CONSTRAINT "VocabularyMeaning_termId_fkey" FOREIGN KEY ("termId") REFERENCES "VocabularyTerm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VocabularyRecording" ADD CONSTRAINT "VocabularyRecording_meaningId_fkey" FOREIGN KEY ("meaningId") REFERENCES "VocabularyMeaning"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VocabularyRecording" ADD CONSTRAINT "VocabularyRecording_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "AudioAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VocabularyRecording" ADD CONSTRAINT "VocabularyRecording_narrationId_fkey" FOREIGN KEY ("narrationId") REFERENCES "TextNarration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VocabularyUsage" ADD CONSTRAINT "VocabularyUsage_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "VocabularyRecording"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VocabularyUsage" ADD CONSTRAINT "VocabularyUsage_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VocabularyUsage" ADD CONSTRAINT "VocabularyUsage_textReleaseId_fkey" FOREIGN KEY ("textReleaseId") REFERENCES "TextRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VocabularyPreference" ADD CONSTRAINT "VocabularyPreference_meaningId_fkey" FOREIGN KEY ("meaningId") REFERENCES "VocabularyMeaning"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VocabularyPreference" ADD CONSTRAINT "VocabularyPreference_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "VocabularyRecording"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
