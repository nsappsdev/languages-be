-- Preserve each existing reader's translation lane before appearance is edited.
UPDATE "AppSettings" SET "translationLineHeight" =
  ("translationFontMaxSize" + 4.0) / GREATEST("translationFontMaxSize", 1);
