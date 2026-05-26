-- Destructive development migration: vocabulary is now owned by each lesson.
DROP TABLE IF EXISTS "LearnerLessonDictionaryEntry" CASCADE;
DROP TABLE IF EXISTS "LessonDictionaryEntry" CASCADE;
DROP TABLE IF EXISTS "LearnerVocabulary" CASCADE;
DROP TABLE IF EXISTS "VocabularyTranslation" CASCADE;
DROP TABLE IF EXISTS "VocabularyEntry" CASCADE;

DROP TYPE IF EXISTS "LearnerLessonDictionaryStatus";
DROP TYPE IF EXISTS "LearnerWordStatus";

CREATE TYPE "LearnerLessonVocabularyStatus" AS ENUM ('NEW', 'LEARNING', 'LEARNED');

CREATE TABLE "LessonVocabularyEntry" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "sourceItemId" TEXT,
    "englishText" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "kind" "VocabularyKind" NOT NULL DEFAULT 'WORD',
    "order" INTEGER NOT NULL,
    "notes" TEXT,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LessonVocabularyEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LessonVocabularyTranslation" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL,
    "translation" TEXT NOT NULL,
    "usageExample" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LessonVocabularyTranslation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearnerLessonVocabularyEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "status" "LearnerLessonVocabularyStatus" NOT NULL DEFAULT 'NEW',
    "rightSwipes" INTEGER NOT NULL DEFAULT 0,
    "leftSwipes" INTEGER NOT NULL DEFAULT 0,
    "lastReviewedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnerLessonVocabularyEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LessonVocabularyEntry_lessonId_normalizedText_key" ON "LessonVocabularyEntry"("lessonId", "normalizedText");
CREATE UNIQUE INDEX "LessonVocabularyEntry_lessonId_order_key" ON "LessonVocabularyEntry"("lessonId", "order");
CREATE INDEX "LessonVocabularyEntry_lessonId_sourceItemId_idx" ON "LessonVocabularyEntry"("lessonId", "sourceItemId");

CREATE UNIQUE INDEX "LessonVocabularyTranslation_entryId_languageCode_key" ON "LessonVocabularyTranslation"("entryId", "languageCode");

CREATE UNIQUE INDEX "LearnerLessonVocabularyEntry_userId_lessonId_entryId_key" ON "LearnerLessonVocabularyEntry"("userId", "lessonId", "entryId");
CREATE INDEX "LearnerLessonVocabularyEntry_userId_lessonId_status_idx" ON "LearnerLessonVocabularyEntry"("userId", "lessonId", "status");
CREATE INDEX "LearnerLessonVocabularyEntry_lessonId_entryId_idx" ON "LearnerLessonVocabularyEntry"("lessonId", "entryId");

ALTER TABLE "LessonVocabularyEntry" ADD CONSTRAINT "LessonVocabularyEntry_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LessonVocabularyEntry" ADD CONSTRAINT "LessonVocabularyEntry_sourceItemId_fkey" FOREIGN KEY ("sourceItemId") REFERENCES "LessonItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LessonVocabularyTranslation" ADD CONSTRAINT "LessonVocabularyTranslation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "LessonVocabularyEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearnerLessonVocabularyEntry" ADD CONSTRAINT "LearnerLessonVocabularyEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearnerLessonVocabularyEntry" ADD CONSTRAINT "LearnerLessonVocabularyEntry_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearnerLessonVocabularyEntry" ADD CONSTRAINT "LearnerLessonVocabularyEntry_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "LessonVocabularyEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
