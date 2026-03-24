-- CreateEnum
CREATE TYPE "ProgressEventType" AS ENUM ('ITEM_STARTED', 'ITEM_COMPLETED', 'LESSON_COMPLETED');

-- CreateTable
CREATE TABLE "LearnerProgressEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "lessonItemId" TEXT,
    "eventType" "ProgressEventType" NOT NULL,
    "completion" INTEGER,
    "clientTimestamp" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearnerProgressEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LearnerProgressEvent_idempotencyKey_key" ON "LearnerProgressEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LearnerProgressEvent_userId_createdAt_idx" ON "LearnerProgressEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LearnerProgressEvent_lessonId_createdAt_idx" ON "LearnerProgressEvent"("lessonId", "createdAt");

-- AddForeignKey
ALTER TABLE "LearnerProgressEvent" ADD CONSTRAINT "LearnerProgressEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
