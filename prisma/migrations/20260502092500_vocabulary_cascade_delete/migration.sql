-- DropForeignKey
ALTER TABLE "LearnerLessonDictionaryEntry" DROP CONSTRAINT "LearnerLessonDictionaryEntry_entryId_fkey";

-- DropForeignKey
ALTER TABLE "LearnerVocabulary" DROP CONSTRAINT "LearnerVocabulary_entryId_fkey";

-- DropForeignKey
ALTER TABLE "LessonDictionaryEntry" DROP CONSTRAINT "LessonDictionaryEntry_entryId_fkey";

-- DropForeignKey
ALTER TABLE "VocabularyTranslation" DROP CONSTRAINT "VocabularyTranslation_entryId_fkey";

-- AddForeignKey
ALTER TABLE "VocabularyTranslation" ADD CONSTRAINT "VocabularyTranslation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "VocabularyEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnerVocabulary" ADD CONSTRAINT "LearnerVocabulary_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "VocabularyEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonDictionaryEntry" ADD CONSTRAINT "LessonDictionaryEntry_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "VocabularyEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnerLessonDictionaryEntry" ADD CONSTRAINT "LearnerLessonDictionaryEntry_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "VocabularyEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
