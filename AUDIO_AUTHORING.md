# Text/audio authoring and learner delivery

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

V2 learner delivery uses separate `/api/learner/*` routes and an explicit
lesson publication. `GET/POST/PATCH /api/lessons*` behavior for existing clients is unchanged (see
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
time. `TextRelease` stores an immutable admin-approval snapshot. Approval does
**not** publish to learners; a separate `LessonPublication` freezes the ordered
text releases and exposes them through the learner API.

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

No legacy-vocabulary backfill script, no
alignment boundary-correction endpoint, no read-only history endpoint.
Legacy per-segment-timing/media/vocabulary routes are not yet blocked for a
text that already has V2 content (they can't corrupt V2 data, since it lives
in separate tables, but could be a confusing dual-edit surface until a
follow-up adds that guard). Automated provider tests use mocked HTTP and
synthetic fixtures; they do not prove live account compatibility. The local
acceptance handoff records separate, explicitly authorized live generation.

## Learner publication and playback

The additive `20260917090000_learner_text_releases` migration adds frozen release
manifests, lesson publications, occurrence-scoped learner word states, and reader
progress. It does not backfill old approvals; approve them again to create a snapshot.

- `POST /api/admin/lessons/:lessonId/reader-publications` accepts ordered
  `textReleaseIds`. Every active lesson item must have a current approved release.
  The admin's **Publish to mobile** action calls this separately from approval.
- `POST /api/admin/lessons/:lessonId/reader-publications/revoke` withdraws every
  publication of the lesson, including versions pinned by older sessions.
- `GET /api/learner/lessons` lists current publications for authenticated users.
- `GET /api/learner/lessons/:lessonId/manifest` and
  `GET /api/learner/publications/:publicationId` return frozen schema-version-2
  content plus that user's progress and word states. Older versions remain
  readable until withdrawal. There is no additional course-enrollment gate.
- `GET /api/learner/audio-assets/:assetId/content?publicationId=...` requires
  authentication and asset membership in an active publication. It supports
  full content and byte ranges (200/206/416). Storage remains private.
- `GET /api/learner/words`, `PUT /api/learner/word-state`, and
  `PUT /api/learner/reader-progress` use release/occurrence identity. Updates are
  absolute states with client timestamps; older writes are ignored and completion
  cannot be undone by a delayed playback-position write.

Approval validates revision/narration/alignment/occurrence/clip lineage, real
sample bounds, and READY assets whose file length and SHA-256 match storage.
Publication rechecks current readiness and frozen assets. Draft edits clear the
approval pointer without changing published snapshots. Late generation jobs for
an older revision retain history without replacing the current narration.

Manifest offsets are UTF-16 character indexes and start-inclusive/end-exclusive
audio samples. Legacy Armenian `am` translations map to `hy` only in this reader
projection. Native/browser clients use the recorded samples, never estimated
word positions. The mobile client makes no ElevenLabs requests.

Unit tests include range parsing; compiled `readerApi.test.js` covers learner
authorization, publication idempotency, immutability, contextual identity,
withdrawal, stale writes, unavailable clips, and stale job attachment. Use only
a verified local disposable database for integration tests.
