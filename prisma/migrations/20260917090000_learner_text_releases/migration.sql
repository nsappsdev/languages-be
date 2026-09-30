-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN     "currentPublicationId" TEXT;

-- AlterTable
ALTER TABLE "TextRelease" ADD COLUMN     "manifestSnapshot" JSONB;

-- CreateTable
CREATE TABLE "LessonPublication" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "assetIds" TEXT[],
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "LessonPublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReaderWordState" (
    "userId" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "textReleaseId" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "status" "LearnerLessonVocabularyStatus" NOT NULL DEFAULT 'LEARNING',
    "clientUpdatedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReaderWordState_pkey" PRIMARY KEY ("userId","textReleaseId","occurrenceId")
);

-- CreateTable
CREATE TABLE "ReaderProgress" (
    "userId" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "textReleaseId" TEXT NOT NULL,
    "lastSample" INTEGER NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "clientUpdatedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReaderProgress_pkey" PRIMARY KEY ("userId","textReleaseId")
);

-- CreateIndex
CREATE INDEX "LessonPublication_lessonId_createdAt_idx" ON "LessonPublication"("lessonId", "createdAt");

-- AddForeignKey
ALTER TABLE "LessonPublication" ADD CONSTRAINT "LessonPublication_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReaderWordState" ADD CONSTRAINT "ReaderWordState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReaderWordState" ADD CONSTRAINT "ReaderWordState_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "LessonPublication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReaderProgress" ADD CONSTRAINT "ReaderProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReaderProgress" ADD CONSTRAINT "ReaderProgress_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "LessonPublication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
