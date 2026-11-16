ALTER TABLE "TextWorkspace" ADD COLUMN "sentenceEndOffsets" JSONB;
ALTER TABLE "TextNarration" ALTER COLUMN "assetId" DROP NOT NULL;
ALTER TABLE "TextAlignment" ALTER COLUMN "narrationId" DROP NOT NULL;
