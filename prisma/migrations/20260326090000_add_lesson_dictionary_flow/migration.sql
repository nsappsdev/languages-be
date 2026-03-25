-- CreateEnum
CREATE TYPE "LearnerLessonDictionaryStatus" AS ENUM ('NEW', 'LEARNING', 'LEARNED');

-- CreateTable
CREATE TABLE "LessonDictionaryEntry" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "sourceItemId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LessonDictionaryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearnerLessonDictionaryEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "dictionaryEntryId" TEXT,
    "status" "LearnerLessonDictionaryStatus" NOT NULL DEFAULT 'NEW',
    "rightSwipes" INTEGER NOT NULL DEFAULT 0,
    "leftSwipes" INTEGER NOT NULL DEFAULT 0,
    "lastReviewedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnerLessonDictionaryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LessonDictionaryEntry_lessonId_entryId_key" ON "LessonDictionaryEntry"("lessonId", "entryId");

-- CreateIndex
CREATE UNIQUE INDEX "LessonDictionaryEntry_lessonId_order_key" ON "LessonDictionaryEntry"("lessonId", "order");

-- CreateIndex
CREATE INDEX "LessonDictionaryEntry_entryId_idx" ON "LessonDictionaryEntry"("entryId");

-- CreateIndex
CREATE INDEX "LessonDictionaryEntry_lessonId_sourceItemId_idx" ON "LessonDictionaryEntry"("lessonId", "sourceItemId");

-- CreateIndex
CREATE UNIQUE INDEX "LearnerLessonDictionaryEntry_userId_lessonId_entryId_key" ON "LearnerLessonDictionaryEntry"("userId", "lessonId", "entryId");

-- CreateIndex
CREATE INDEX "LearnerLessonDictionaryEntry_userId_lessonId_status_idx" ON "LearnerLessonDictionaryEntry"("userId", "lessonId", "status");

-- CreateIndex
CREATE INDEX "LearnerLessonDictionaryEntry_lessonId_entryId_idx" ON "LearnerLessonDictionaryEntry"("lessonId", "entryId");

-- AddForeignKey
ALTER TABLE "LessonDictionaryEntry" ADD CONSTRAINT "LessonDictionaryEntry_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonDictionaryEntry" ADD CONSTRAINT "LessonDictionaryEntry_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "VocabularyEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonDictionaryEntry" ADD CONSTRAINT "LessonDictionaryEntry_sourceItemId_fkey" FOREIGN KEY ("sourceItemId") REFERENCES "LessonItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnerLessonDictionaryEntry" ADD CONSTRAINT "LearnerLessonDictionaryEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnerLessonDictionaryEntry" ADD CONSTRAINT "LearnerLessonDictionaryEntry_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnerLessonDictionaryEntry" ADD CONSTRAINT "LearnerLessonDictionaryEntry_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "VocabularyEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnerLessonDictionaryEntry" ADD CONSTRAINT "LearnerLessonDictionaryEntry_dictionaryEntryId_fkey" FOREIGN KEY ("dictionaryEntryId") REFERENCES "LessonDictionaryEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
