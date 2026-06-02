ALTER TABLE "LessonItem"
ADD COLUMN "chunkTimings" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "LessonVocabularyEntry"
ADD COLUMN "focusText" TEXT,
ADD COLUMN "focusNormalizedText" TEXT;

ALTER TABLE "AppSettings"
ADD COLUMN "wordRepetitionPauseMs" INTEGER NOT NULL DEFAULT 800;
