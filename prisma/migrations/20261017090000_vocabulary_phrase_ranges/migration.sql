-- Existing selections remain single words. Published snapshots are untouched.
ALTER TABLE "TextVocabularyEntry" ADD COLUMN "endOccurrenceId" TEXT;
