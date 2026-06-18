ALTER TABLE "LearnerLessonVocabularyEntry"
ADD COLUMN "correctStreak" INTEGER NOT NULL DEFAULT 0;

CREATE TYPE "VocabularyReviewDecision" AS ENUM ('AGAIN', 'KNOW');

CREATE TABLE "LearnerVocabularyReviewDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "decision" "VocabularyReviewDecision" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "resultingStatus" "LearnerLessonVocabularyStatus" NOT NULL,
    "resultingCorrectStreak" INTEGER NOT NULL,
    "resultingRightSwipes" INTEGER NOT NULL,
    "resultingLeftSwipes" INTEGER NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearnerVocabularyReviewDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LearnerVocabularyReviewDecision_userId_idempotencyKey_key"
ON "LearnerVocabularyReviewDecision"("userId", "idempotencyKey");

CREATE INDEX "LearnerVocabularyReviewDecision_userId_lessonId_createdAt_idx"
ON "LearnerVocabularyReviewDecision"("userId", "lessonId", "createdAt");

CREATE INDEX "LearnerVocabularyReviewDecision_entryId_idx"
ON "LearnerVocabularyReviewDecision"("entryId");

ALTER TABLE "LearnerVocabularyReviewDecision"
ADD CONSTRAINT "LearnerVocabularyReviewDecision_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearnerVocabularyReviewDecision"
ADD CONSTRAINT "LearnerVocabularyReviewDecision_lessonId_fkey"
FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearnerVocabularyReviewDecision"
ADD CONSTRAINT "LearnerVocabularyReviewDecision_entryId_fkey"
FOREIGN KEY ("entryId") REFERENCES "LessonVocabularyEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
