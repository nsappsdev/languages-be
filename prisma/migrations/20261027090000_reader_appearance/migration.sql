CREATE TABLE "ReaderFont" (
  "id" TEXT NOT NULL PRIMARY KEY, "label" TEXT NOT NULL,
  "familyName" TEXT NOT NULL, "subfamilyName" TEXT NOT NULL, "postscriptName" TEXT NOT NULL,
  "format" TEXT NOT NULL, "sha256" TEXT NOT NULL, "byteLength" INTEGER NOT NULL,
  "supportsEnglish" BOOLEAN NOT NULL, "supportsArmenian" BOOLEAN NOT NULL,
  "archivedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "ReaderFont_sha256_key" ON "ReaderFont"("sha256");
ALTER TABLE "AppSettings"
  ADD COLUMN "mainTextFontId" TEXT,
  ADD COLUMN "translationFontId" TEXT,
  ADD COLUMN "mainTextLineHeight" DOUBLE PRECISION NOT NULL DEFAULT 1.333333,
  ADD COLUMN "translationLineHeight" DOUBLE PRECISION NOT NULL DEFAULT 1.266667,
  ADD COLUMN "translationGap" DOUBLE PRECISION NOT NULL DEFAULT 2,
  ADD COLUMN "readingRowGap" DOUBLE PRECISION NOT NULL DEFAULT 4;
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_mainTextFontId_fkey" FOREIGN KEY ("mainTextFontId") REFERENCES "ReaderFont"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_translationFontId_fkey" FOREIGN KEY ("translationFontId") REFERENCES "ReaderFont"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
