-- Retain immutable publications, learner history and reusable vocabulary assets.
ALTER TABLE "Lesson" ADD COLUMN "archivedAt" TIMESTAMP(3);
