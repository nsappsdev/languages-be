-- Add defaults for retained historical columns; new code never reads/writes them.
ALTER TABLE "LessonItem" ALTER COLUMN "audioUrl" SET DEFAULT '';
ALTER TABLE "LessonItem" ALTER COLUMN "segments" SET DEFAULT '[]';

-- Preserve identities, exact text bytes, ordering, metadata, history and audio.
INSERT INTO "TextWorkspace" ("textId", "archivedAt", "updatedAt")
SELECT id, "archivedAt", CURRENT_TIMESTAMP FROM "LessonItem"
ON CONFLICT ("textId") DO NOTHING;

INSERT INTO "TextContentRevision" (id, "textId", sequence, text, "textSha256", "sourceLanguage", "authorId")
SELECT 'bootstrap-' || item.id, item.id, 1, item.text,
  encode(sha256(convert_to(item.text, 'UTF8')), 'hex'), 'en', lesson."authorId"
FROM "LessonItem" item JOIN "Lesson" lesson ON lesson.id = item."lessonId"
WHERE NOT EXISTS (SELECT 1 FROM "TextContentRevision" revision WHERE revision."textId" = item.id);

UPDATE "TextWorkspace" workspace SET "currentContentRevisionId" = revision.id, "updatedAt" = CURRENT_TIMESTAMP
FROM "TextContentRevision" revision
WHERE revision."textId" = workspace."textId" AND workspace."currentContentRevisionId" IS NULL
  AND revision.sequence = (SELECT MAX(r.sequence) FROM "TextContentRevision" r WHERE r."textId" = workspace."textId");

-- The old status is not publication evidence. No publication or paid job is created.
UPDATE "Lesson" SET status = 'DRAFT', "publishedAt" = NULL WHERE "currentPublicationId" IS NULL;
