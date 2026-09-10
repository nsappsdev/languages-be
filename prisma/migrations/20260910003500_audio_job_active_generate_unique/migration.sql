-- Prevent more than one concurrently active (QUEUED/RUNNING) GENERATE_NARRATION
-- job per text. EXTRACT_CLIPS jobs are not restricted this way because a text
-- can have several independent extraction batches in flight for different
-- selected entries, but only one in-flight full narration regeneration makes
-- sense per text.
CREATE UNIQUE INDEX "AudioJob_active_generate_per_text"
  ON "AudioJob" ("textId")
  WHERE "kind" = 'GENERATE_NARRATION' AND "status" IN ('QUEUED', 'RUNNING');
