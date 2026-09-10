# Text/audio authoring (admin-only, additive)

Backend support for: admin writes a text → generates one full ElevenLabs
narration → words/sentences are aligned automatically → admin selects only
the words worth learning → clips are extracted from the original narration
(never separate TTS per word) → admin adds contextual translations →
readiness/preview → approve a `TextRelease`.

"Text" = one existing `LessonItem`. A `Lesson` is a container of ordered
texts. Each text owns an independent vocabulary library: the same spelling
in two different texts (or two occurrences in the same text) always gets
independent entries, translations and clips — there is no global word
dedup.

None of this is wired into learner-facing routes yet. `GET/POST/PATCH
/api/lessons*` behavior for existing clients is unchanged (see
`src/integration/__tests__/lessonIdentity.test.ts` and
`textAuthoringApi.test.ts`'s legacy-read assertions).

## Setup

Required environment variables (see `.env.example`-style list below; do not
commit real values):

- `DATABASE_URL` — existing Postgres connection string.
- `ELEVENLABS_API_KEY` — server-side only, never sent to the admin frontend.
  Leaving it unset disables narration generation with a clear `503
  AUDIO_GENERATION_NOT_CONFIGURED` response; no fake success is returned.
- `ELEVENLABS_DEFAULT_VOICE_ID` — the server-allowlisted voice ID to use.
  Voice choice, pronunciation policy and credit cap are an owner decision,
  not something this backend infers.
- `AUDIO_WORKER_ENABLED` — `true`/`false` (default `false`). The single
  in-process job worker only runs when this is explicitly enabled, so a
  freshly-deployed backend never silently starts making provider calls.
- `AUDIO_WORKER_POLL_INTERVAL_MS` — default `2000`.
- `AUDIO_AUTHORING_STORAGE_ROOT` — optional; defaults to `<cwd>/var/audio-authoring`,
  which is outside `public/` (never served by the `/media` static route) and
  is gitignored.

## Data model (additive Prisma migrations)

`TextWorkspace` (1:1 with `LessonItem`) → `TextContentRevision` (immutable,
one per saved text edit) → `TextNarration` (one ElevenLabs full-text
generation result) → `TextAlignment` (our deterministic character→word
mapping, status `OK`/`NEEDS_REVIEW`) → `WordOccurrence` (every spoken word,
with distinct IDs for repeated occurrences) → `TextVocabularyEntry` (one per
selected occurrence, never global) → `TextVocabularyTranslation` → `WordClip`
(sample-exact slice of the *same* narration, not a new TTS call).
`AudioJob` is a minimal Postgres-backed job table (`GENERATE_NARRATION`,
`EXTRACT_CLIPS`) with idempotency keys, `FOR UPDATE SKIP LOCKED` claiming,
and a partial unique index limiting a text to one active generation at a
time. `TextRelease` is an immutable admin-approval snapshot; it does **not**
publish anything to learners — that gate is intentionally left disabled
pending a separate product decision (see limitations below).

`LessonItem` gained one additive column, `archivedAt`. The previous
`PATCH /lessons/:id` delete-then-recreate-all-items behavior was replaced
with an in-place diff (`src/lib/lessonItemReconciliation.ts`): retained rows
keep their ID, omitted rows are archived (not deleted), and reorders use a
two-phase negative-order staging step to avoid unique-constraint collisions.

## API

All new routes are under `/api/admin/lessons/:lessonId/texts/:textId/...`
plus `/api/admin/audio-jobs/:jobId`, `/api/admin/audio-jobs/:jobId/retry`,
and `/api/admin/audio-assets/:assetId/content` (Range-aware, admin-auth
gated, private storage — never the public `/media` route). See
`src/routes/textAuthoring.ts` and `src/routes/adminAudioAssets.ts` for exact
request/response shapes; they are intentionally not yet reflected in
`src/swagger/swagger.ts` (flagged as a follow-up, not silently omitted).

## Jobs and the worker

`POST .../narration-jobs` and `POST .../clip-jobs` require an
`Idempotency-Key` header. The same key + same canonical request payload
replays the existing job; the same key + a different payload is a `409`.
Jobs are `QUEUED` until the worker (`src/workers/audioWorker.ts`) claims and
runs them; enable it with `AUDIO_WORKER_ENABLED=true`. Generation and
alignment happen in the same `GENERATE_NARRATION` job (alignment is free,
local, and computed from data the same provider call already returned — no
extra paid request). A malformed/missing/mismatched alignment does not fail
the job; the narration is still saved and the alignment is marked
`NEEDS_REVIEW`, which blocks *word selection* on that text, not narration
playback.

## Migrations / local verification

Migrations were generated and applied against a disposable local Postgres
instance created for this work (`languages_be_disposable_test`), never an
existing/production `DATABASE_URL`. To reproduce:

```bash
# .env pointing at a throwaway DATABASE_URL/SHADOW_DATABASE_URL
./node_modules/.bin/prisma migrate deploy
npm run build
node --test dist/lib/__tests__/*.test.js          # unit tests, no DB required
node --test dist/integration/__tests__/*.test.js  # requires the disposable DB above
```

`src/integration/__tests__/helpers/testDbGuard.ts` refuses to run unless
`DATABASE_URL` contains the literal string `disposable` and does not look
production-like, and is loaded before any Prisma client is constructed by
the integration test helpers.

## Known limitations (see the implementation report for the full list)

No lesson-level publish/release, no legacy-vocabulary backfill script, no
alignment boundary-correction endpoint, no read-only history endpoint.
Legacy per-segment-timing/media/vocabulary routes are not yet blocked for a
text that already has V2 content (they can't corrupt V2 data, since it lives
in separate tables, but could be a confusing dual-edit surface until a
follow-up adds that guard). No live ElevenLabs credentials were used; the
provider adapter is verified via unit tests (mocked HTTP) and an HTTP-level
integration test using a synthetic fixture response, not a real account.
