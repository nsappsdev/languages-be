ALTER TABLE "AudioAsset" ALTER COLUMN "textId" DROP NOT NULL;
ALTER TABLE "VocabularyRecording" ALTER COLUMN "narrationId" DROP NOT NULL;
ALTER TABLE "VocabularyRecording" ADD COLUMN "standalone" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TextVocabularyEntry" ADD COLUMN "recordingId" TEXT;
ALTER TABLE "TextVocabularyEntry" ADD CONSTRAINT "TextVocabularyEntry_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "VocabularyRecording"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "VocabularyAudio" (
  "id" TEXT NOT NULL,
  "termId" TEXT NOT NULL,
  "voiceId" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "status" "AudioJobStatus" NOT NULL,
  "ownerJobId" TEXT NOT NULL,
  "assetId" TEXT,
  "errorCode" TEXT,
  "retryable" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VocabularyAudio_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VocabularyAudio_termId_fkey" FOREIGN KEY ("termId") REFERENCES "VocabularyTerm"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "VocabularyAudio_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "AudioAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VocabularyAudio_termId_voiceId_model_key" ON "VocabularyAudio"("termId", "voiceId", "model");
CREATE UNIQUE INDEX "AudioJob_one_active_vocabulary_per_text" ON "AudioJob"("textId") WHERE "kind" = 'GENERATE_VOCABULARY' AND "status" IN ('QUEUED', 'RUNNING');
