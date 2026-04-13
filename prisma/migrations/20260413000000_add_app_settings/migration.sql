CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "unknownWordRepetitions" INTEGER NOT NULL DEFAULT 2,
    "mainTextFontFamily" TEXT NOT NULL DEFAULT 'System',
    "mainTextFontSize" INTEGER NOT NULL DEFAULT 18,
    "translationFontFamily" TEXT NOT NULL DEFAULT 'System',
    "translationFontSize" INTEGER NOT NULL DEFAULT 12,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AppSettings" ("id", "unknownWordRepetitions", "mainTextFontFamily", "mainTextFontSize", "translationFontFamily", "translationFontSize", "updatedAt")
VALUES ('global', 2, 'System', 18, 'System', 12, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
