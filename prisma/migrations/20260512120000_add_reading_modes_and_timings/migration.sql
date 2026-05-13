ALTER TABLE "LessonItem"
ADD COLUMN "wordTimings" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "sentenceTimings" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "AppSettings"
ADD COLUMN "readingModes" JSONB;

UPDATE "AppSettings"
SET "readingModes" = jsonb_build_array(
  jsonb_build_object(
    'id', 'introduction',
    'enabled', true,
    'displayName', 'Introduction',
    'order', 0
  ),
  jsonb_build_object(
    'id', 'teaching',
    'enabled', true,
    'displayName', 'Teaching',
    'order', 1,
    'unknownWordRepetitions', COALESCE("unknownWordRepetitions", 5)
  ),
  jsonb_build_object(
    'id', 'deep_learning',
    'enabled', true,
    'displayName', 'Deep Learning',
    'order', 2,
    'unknownWordRepetitions', COALESCE("unknownWordRepetitions", 5),
    'repeatSentenceWhenUnknownCountAtLeast', 2,
    'sentenceRepetitions', 2
  )
)
WHERE "readingModes" IS NULL;

ALTER TABLE "AppSettings"
ALTER COLUMN "readingModes" SET DEFAULT '[
  {"id":"introduction","enabled":true,"displayName":"Introduction","order":0},
  {"id":"teaching","enabled":true,"displayName":"Teaching","order":1,"unknownWordRepetitions":5},
  {"id":"deep_learning","enabled":true,"displayName":"Deep Learning","order":2,"unknownWordRepetitions":5,"repeatSentenceWhenUnknownCountAtLeast":2,"sentenceRepetitions":2}
]',
ALTER COLUMN "readingModes" SET NOT NULL;

ALTER TABLE "AppSettings"
DROP COLUMN "unknownWordRepetitions";
