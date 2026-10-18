# Text authoring and publication

One ordered `LessonItem` is one text. `TextContentRevision` is authoritative. The admin creates a lesson with one or more pasted texts, explicitly saves and generates ElevenLabs narration, selects aligned word occurrences, adds contextual Armenian translations, prepares vocabulary audio, and clicks **Publish** (or **Update published lesson**). Vocabulary preparation reuses saved audio and generates missing words separately. Repeated words have independent occurrence identities and translations, with shared recordings. Texts may be added, reordered, or removed; removal archives the item. See **Standalone vocabulary audio (2026-10-18)** below for the current generation and rollout contract; dated verification sections describe earlier behavior.

There is no visible approval stage. `TextRelease` and `LessonPublication` remain immutable internally so existing mobile sessions are isolated from edits. Unchanged texts reuse their release identity on a lesson update, preserving their learner state. Unpublish withdraws all versions of a lesson. Lesson visibility is derived exclusively from `currentPublicationId`.

## Configuration

Server-side variables:

- `ELEVENLABS_API_KEY`, `ELEVENLABS_DEFAULT_VOICE_ID`: narration provider credentials and default voice.
- `AUDIO_WORKER_ENABLED=true`: enables explicit narration jobs.
- `AUDIO_WORKER_POLL_INTERVAL_MS`: default 2000.
- `AUDIO_AUTHORING_STORAGE_ROOT`: private persistent directory, default `./var/audio-authoring`.
- `APP_BASE_URL`: remains required for email verification links.

The browser receives authenticated audio blobs, never provider credentials. There is no public uploaded-audio route. Preserve old audio directories as an archive; do not delete their files during rollout. The private audio directory must be readable/writable by the application UID and backed by persistent storage.

## API

All paths below are under `/api`. Authoring endpoints require an admin bearer token.

- `POST /lessons`: `{ title, description?, items: [{ text }, ...] }`. Creates lesson, stable item identities, workspaces and initial revisions in one transaction. Array order is text order. No audio job is created.
- `PATCH /lessons/:id`: `{ title?, description?, items?: [{ id }, ...] }`. An optional list reorders retained active items and archives omitted ones. It does not edit text. Unknown, foreign or duplicate IDs are rejected. At least one item must remain.
- `POST /lessons/:lessonId/items`: `{ text }`. Appends a persisted item and revision in one transaction.
- `GET /admin/lessons/:lessonId/texts/:textId`: saved revision, current narration/alignment and active narration job.
- `POST .../texts/:textId/content-revisions`: `{ text, sourceLanguage?: "en" }`. Byte-identical saves are no-ops. Changes invalidate current narration/alignment and selections/clips through lineage; historical rows are retained.
- `POST .../texts/:textId/narration-jobs`: `{ contentRevisionId, voiceProfileId? }` with `Idempotency-Key`. Explicitly queues full narration, immediately invalidating the old draft narration and selections. Same key/payload returns the same job. One active narration job per text.
- `GET /admin/audio-jobs/:jobId`: durable narration progress/error.
- `GET .../texts/:textId/occurrences`: current aligned sentences and occurrences, translations and verified current clips.
- `PATCH .../texts/:textId/selection`: `{ alignmentId, changes: [{ occurrenceId, selected }] }`.
- `PATCH .../texts/:textId/vocabulary/:entryId`: `{ translations: [{ languageCode: "hy", translation }] }`. Historical `am` input is normalized to `hy`. Every selected occurrence requires a nonblank Armenian translation; other languages alone do not satisfy readiness.
- `GET .../texts/:textId/readiness`: both `canPublish` and `readyForPublication` require all selected words to have translations and valid saved audio. Zero selected learning words is allowed.
- `POST /admin/lessons/:lessonId/publish`: no body, or `{}`. Client-supplied release IDs are rejected.
- `POST /admin/lessons/:lessonId/unpublish`: no body, or `{}`.

Publish returns `201 { publicationId, replay: false, status: "PUBLISHED" }`, or `200 { publicationId, replay: true, status: "PUBLISHED" }` for an unchanged current publication. On success the lesson is immediately visible at `GET /learner/lessons`. Readiness failures return `422 { code: "LESSON_NOT_READY", message, texts: [{ textId, order, readiness, message? }] }`; every failing text is reported during preflight. No partial publication is committed.

Publish locks the lesson row; all draft writers take the same lock. It validates every active text, exact current revision/narration/alignment lineage, ElevenLabs provenance, asset bytes/hash and WAV metadata, alignment quality, Armenian translations, saved recordings, and narration handoff bounds. It creates releases/publication and changes the pointer in one database transaction. Concurrent calls serialize across server processes and replay the same publication. Audio preparation is an explicit earlier operation; publication dispatches no provider requests and performs no extraction. `NEEDS_REVIEW` alignment and overlapping speech spans block publication.

The transaction has a 60-second timeout. A timeout/failure leaves the previous publication intact. Immutable audio files written before a rollback may remain unreferenced; they are deliberately not deleted automatically. Inventory them before an explicit cleanup. For unusually large lessons, a later asynchronous publication job may be appropriate; the current implementation is synchronous and the admin displays progress while waiting.

## Reader compatibility

The current schema-version-2 contract remains unchanged:

- `GET /learner/lessons`, `GET /learner/lessons/:lessonId/manifest`
- `GET /learner/publications/:publicationId` for pinned versions
- `GET /learner/audio-assets/:assetId/content?publicationId=...`, authenticated and supporting byte ranges
- `PUT /learner/word-state`, `PUT /learner/reader-progress`, `GET /learner/words`

Draft changes leave previous publications and their audio intact. An unchanged text's release and state survive metadata updates and edits to another text. Repetition counts, selection rules, authenticated source caching and text-scoped Library behavior remain compatible. The 2026-10-15 playback update prepares a continuous local track with the admin-configured repetition gap; see [mobile playback documentation](../mobile/README.md#smooth-repetition-playback).

## Migration and retained historical data

`20261014090000_text_authoring_backfill` creates missing workspaces and initial revisions from the exact UTF-8 bytes of `LessonItem.text`. Existing revisions win over the bootstrap mirror. Lesson/item IDs, order, title, description and archived items are preserved. No paid jobs or publications are created. Old status-only lessons are left Draft. Already published immutable manifests remain published.

The migration is repeatable and has been verified on a fresh local PostgreSQL database seeded with legacy, archived and modern texts plus learner history. Runtime no longer uses the legacy audio/timing fields. Their columns remain, with defaults for new items, so archived values are preserved. `LessonItem.text` remains an initial bootstrap mirror and is not updated by text editing. `Lesson.status` remains a historical column and is ignored for visibility. `TextWorkspace.approvedTextReleaseId` remains as a historical pointer; there is no approval endpoint.

Retain `LessonVocabularyEntry`, `LessonVocabularyTranslation`, `LearnerLessonVocabularyEntry`, `LearnerVocabularyReviewDecision`, and `LearnerProgressEvent`. Their runtime authoring/legacy vocabulary endpoints have been removed. Existing data has not been inventoried on production because this task explicitly forbids production access. Before any drop, an operator should take a backup, inventory table counts and relationships, export orphaned and active entries and their learner states, and decide on an explicit archival or migration policy. Do not infer occurrence identity from spelling alone. No automatic deletion of production text, learner history, or audio is part of this change.

## Local verification

Use a fresh local migration database and a **separate** local integration database whose database name contains `disposable`. Integration tests reject remote hosts and non-disposable names. Set `DATABASE_URL` explicitly; never reuse deployment credentials.

```sh
npm run prisma:generate
npm run build
npm test
# Against the two explicitly configured local databases:
npx prisma migrate deploy
npx prisma migrate status
# Against only the disposable integration database:
ELEVENLABS_API_KEY=synthetic-test-only ELEVENLABS_DEFAULT_VOICE_ID=synthetic-test-only AUDIO_WORKER_ENABLED=false node --test dist/integration/__tests__/*.test.js
```

Tests use an explicitly synthetic ElevenLabs fetch mock which rejects all non-loopback network requests other than intercepted provider calls. Real provider calls are zero. Keep real keys out of test environments. Admin checks: `npm test`, `npm run lint`, `npm run build`, `npx tsc --noEmit`. Mobile checks: `npm test`, `npm run lint`, `npx tsc --noEmit`.

Deployment is not performed by this refactor. Apply and verify the backfill before starting the new runtime. Retired speech/translation-provider credentials may be removed from CI and deployment environments; the current example and workflow no longer reference them. Keep all ElevenLabs, audio worker/storage and email configuration listed above.

## Merge and rollout notes — 2026-10-15

The backend, admin, and mobile changes are prepared on matching
`feat/elevenlabs-authoring-smooth-repetition` branches in their independent
repositories. Deploy the backend migration/runtime before the corresponding
admin. The mobile repetition correction requires a new mobile build; backend
publication contracts remain compatible with the existing reader.

The backend container runs `prisma migrate deploy` before starting. Keep
`ELEVENLABS_API_KEY`, `ELEVENLABS_DEFAULT_VOICE_ID`, and the persistent private
audio directory configured. The backend and admin deployment workflows trigger
on `main` or explicit workflow dispatch, not feature-branch pushes.

`deploy/docker-compose.yml`, `deploy/Caddyfile`, and `deploy/nginx.conf` preserve
the reviewed workspace deployment templates inside this repository. The workspace
root is not a Git repository. These templates are not installed automatically by
this change. Caddy is the current `/admin` configuration; the nginx template is
the older `/languages/admin` alternative and must match the admin build's base
path if used. Retain existing audio files when removing obsolete public mounts
and routes. The deployment workflow already supplies the private audio compose
override; do not overwrite a server's site-specific configuration blindly.

Verification completed during this work: backend 55 unit and 13 integration
tests plus build and migration/backfill checks; admin 33 tests, lint, TypeScript,
and production build; mobile 71 tests, lint, and TypeScript after the consonant
boundary correction. Browser playback was checked with a real 448-word story.
Exactly one real ElevenLabs request was separately approved for that local
story; all automated tests used mocks. Local preview databases, recordings,
provider responses, and credentials are not part of these commits. No production
deployment or data mutation has been performed.

## Historical refactor verification report — 2026-10-14

At this verification checkpoint, all changes were local and uncommitted. No reset, merge, push, deployment, or production database operation had been performed. The three repositories were clean before editing and were on these original branches and HEADs:

| Repository | Branch | HEAD |
| --- | --- | --- |
| backend | `fix/audio-authoring-deployment` | `9424cc111f4ac3c7822931e4f4caee9e28a97045` |
| admin | `refactor/text-audio-library` | `7d1c3d08b01e8c47fafd9893b5e12e26063cddb2` |
| mobile | `fix/mobile-private-audio-playback` | `37c07680b92c5115d8fd50e5deb851130f06ef62` |

Mobile source was unchanged at this checkpoint; the subsequent repetition work is documented in the mobile README. Workspace-level `docker-compose.yml`, `infra/Caddyfile`, `infra/nginx.conf`, and the two historical mobile-refactor planning documents were updated outside these independent repositories. The historical plans point to this document as the current workflow. Old audio files were preserved; public serving and the public-volume mapping were removed. The compose file configures persistent private audio storage and the narration worker.

### Exact files removed

Paths below are relative to their repository. Backend (15 files):

```text
src/lib/__tests__/audioTranscription.test.ts
src/lib/__tests__/lessonItemReconciliation.test.ts
src/lib/__tests__/lessonTimingAlignment.test.ts
src/lib/__tests__/openaiTranslations.test.ts
src/lib/__tests__/vocabularyIngestion.test.ts
src/lib/audioStorage.ts
src/lib/audioTranscription.ts
src/lib/lessonItemReconciliation.ts
src/lib/lessonTimingAlignment.ts
src/lib/openaiTranscription.ts
src/lib/openaiTranslations.ts
src/lib/vocabularyIngestion.ts
src/routes/lessonVocabulary.ts
src/routes/media.ts
src/scripts/tmpBenchmarkTimingProviders.ts
```

Admin (12 files):

```text
app/(dashboard)/dashboard/more/timing-benchmark-temp/page.tsx
components/lesson-text/ReaderPublication.tsx
components/lesson-text/__tests__/ReaderPublication.test.tsx
hooks/useLessonVocabularyMutations.ts
lib/lessonMissingTranslationsCsv.test.ts
lib/lessonMissingTranslationsCsv.ts
lib/lessonTimingDraft.test.ts
lib/lessonTimingDraft.ts
lib/lessonTimingGrouping.test.ts
lib/lessonTimingGrouping.ts
lib/vocabularyCsv.test.ts
lib/vocabularyCsv.ts
```

The `multer` and `@types/multer` dependencies and `benchmark:timings:temp` script were removed. Builds clean `dist` before compiling so deleted modules and tests cannot survive as stale JavaScript. Retained historical database migrations and plans are not active provider implementations.

### Exact routes removed

These routes are removed, not aliases to the new workflow:

```text
DELETE /api/lessons/:id
DELETE /api/lessons/:lessonId/items/:itemId
DELETE /api/lessons/:lessonId/vocabulary/:entryId
DELETE /api/media/audio
GET    /api/lessons/:lessonId/vocabulary
GET    /api/me/lessons/:lessonId/vocabulary
GET    /api/me/vocabulary/lessons
PATCH  /api/lessons/:lessonId/items/:itemId/segments/:segmentId/timings
PATCH  /api/lessons/:lessonId/vocabulary/:entryId
PATCH  /api/me/lessons/:lessonId/vocabulary/:entryId
POST   /api/admin/lessons/:lessonId/reader-publications
POST   /api/admin/lessons/:lessonId/reader-publications/revoke
POST   /api/admin/lessons/:lessonId/texts/:textId/clip-jobs
POST   /api/admin/lessons/:lessonId/texts/:textId/releases
POST   /api/lessons/:lessonId/items/:itemId/benchmark-timings-temp
POST   /api/lessons/:lessonId/items/:itemId/transcribe-timings
POST   /api/lessons/:lessonId/vocabulary
POST   /api/lessons/:lessonId/vocabulary/ai-translations
POST   /api/lessons/:lessonId/vocabulary/bulk-delete
POST   /api/lessons/:lessonId/vocabulary/import
POST   /api/lessons/:lessonId/vocabulary/pull-from-timings
POST   /api/me/lessons/:lessonId/vocabulary/:entryId/review
POST   /api/media/audio
```

Public `/media/*` static serving is also removed, including reverse-proxy routes. Text removal now archives via the ordered item list in `PATCH /api/lessons/:id`. Unpublish uses the new endpoint documented above. Old queued `EXTRACT_CLIPS` jobs remain executable for compatibility, with current-lineage validation and the same local PCM extractor; no public route creates these jobs.

### Verification results

| Check | Result |
| --- | --- |
| Backend `npm test` | 55 tests, 9 suites passed |
| Backend `npm run build` | Passed; also rerun by `npm test` |
| Compiled backend integration tests | 13 tests, 3 suites passed |
| Admin `npm test` | 27 tests, 9 suites passed |
| Admin lint, production build, `npx tsc --noEmit` | All passed |
| Mobile `npm test` | 51 tests, 10 suites passed |
| Mobile lint and `npx tsc --noEmit` | Both passed |
| Prisma migration status, both local databases | 21 migrations; up to date |
| Seeded legacy backfill and repeated SQL | Passed preservation and idempotency assertions |
| Real-browser admin and mobile web smoke | Passed with explicitly synthetic provider audio |

Integration coverage includes concurrent duplicate Publish calls, exact narration-slice clips, transaction rollback after a later text's clip extraction fails, all affected texts in readiness errors, missing Armenian translation, `NEEDS_REVIEW`, old selections, stale/quarantined clips, regeneration in progress, late narration completion, immediate learner visibility, unchanged text release/state reuse, immutable pinned sessions, authenticated/ranged audio, and Unpublish. Creation tests cover stable identities and initial revisions in the same transaction.

The fresh PostgreSQL 16 cluster is isolated at `127.0.0.1:55436`. Migration verification used `languages_migration_20261014`; integration tests used the separate `languages_integration_disposable_20261014`. The migration test seeded the previous schema with legacy text, archived text, an existing authoritative revision, and vocabulary/learner history, then applied the backfill and reran its SQL. Exact UTF-8 text, IDs, order, metadata, archival state, old audio paths, existing revisions and history were preserved; no jobs or publications were created. No production data inventory was attempted.

The browser smoke created a two-text lesson, confirmed per-text errors before narration, explicitly generated synthetic ElevenLabs narration, selected occurrences and saved Armenian translations, and published with one click. The lesson appeared immediately in mobile. Narration and word clips played through private authenticated delivery. Editing blocked publication; regeneration required fresh selections and clips. Republish delivered the changed text, while an already-open reader session retained the previous text and translation. The second text remained ordered and the Library remained text-scoped. Mobile browser error logs were empty.

Logs and migration-fixture scripts are preserved under workspace `.local-refactor-20261014/`. Final logs include `logs/backend-unit.log`, `logs/backend-integration.log`, `logs/admin-tests.log`, `logs/admin-lint.log`, `logs/admin-build.log`, `logs/admin-typecheck.log`, `logs/mobile-test.log`, `logs/mobile-lint.log`, `logs/mobile-tsc.log`, `logs/backfill-verification.log`, `logs/migration-status.log`, and `logs/integration-migration-status.log`. Temporary smoke services and the local test cluster are stopped after verification; their files remain available.

No unresolved functional defect was reproduced. One intermediate integration run competed with the smoke server's worker on the same disposable database; stopping that worker and rerunning the suite passed. Keep smoke workers stopped during integration tests. The sandbox initially prevented local PostgreSQL access and the Next.js build's local port binding; reruns with the necessary local permissions passed. Existing browser-list freshness and Expo dependency-version advisories remain. Real provider response quality and native-device playback were not exercised; the provider was mocked and mobile production code was unchanged.

At that verification date publication performed local extraction in a 60-second database transaction. The 2026-10-18 standalone vocabulary flow replaces that extraction step with explicit audio preparation before publication.

**Real ElevenLabs requests: 0.** Test and browser fixtures intercept the provider host and prohibit other non-loopback network access. No paid word TTS or narration was requested.

### Retired deployment secrets

These variables can be removed from CI and deployment secret stores; no active backend feature requires them:

```text
OPENAI_API_KEY
DASHSCOPE_API_KEY
DASHSCOPE_WORKSPACE_ID
DASHSCOPE_REGION
TIMING_TRANSCRIPTION_PROVIDER
```

The obsolete OpenAI translation endpoint was part of the removed legacy vocabulary workflow; there are no remaining unrelated OpenAI callers. Obsolete entries were removed from the local backend environment, examples, compose configuration, and workflow forwarding without printing secret values. Remote secret stores were not modified. Retain `APP_BASE_URL`, all ElevenLabs and private-audio configuration, and unrelated authentication/email/database credentials.

## Bulk vocabulary and phrases (2026-10-17)

`TextVocabularyEntry.endOccurrenceId` is nullable: null retains the existing single-word behavior; a non-null value includes every aligned occurrence from `occurrenceId` through that endpoint. Both endpoints must belong to the current alignment and the same sentence, in forward order. Selected ranges cannot overlap. Source alignment words and prior published manifests remain intact. The additive migration is `20261017090000_vocabulary_phrase_ranges`.

`PATCH .../selection` accepts an optional `endOccurrenceId` on each selection change. Deselecting preserves the stored range and translation. Selecting a different range clears its previous translations so the meaning of one word is never silently assigned to a different phrase.

`POST /admin/lessons/:lessonId/texts/:textId/vocabulary/import` accepts `{ alignmentId, expectedDraftVersion, entries: [{ occurrenceId, endOccurrenceId?, translation }] }`. The occurrences response now includes `draftVersion` for the preview's concurrency check and each entry's `endOccurrenceId`. Import accepts 1–500 entries with nonblank Armenian translations, takes the lesson lock, validates the entire batch, then saves all selections and `hy` translations in one transaction. Stale previews return 409; invalid ranges return 422; overlapping ranges return 409. Other languages are preserved for unchanged ranges. Auth, text ownership, archival, and current narration/alignment checks apply exactly as in manual authoring.

Publication joins the existing first/last word cut boundaries into one phrase clip, checks the exact bytes and bounds, and snapshots a single reader occurrence spanning the phrase. Covered interior words are omitted only from that new reader snapshot, preventing duplicate rendering or separate repetitions. The schema-version-2 shape, occurrence anchor identity, reading settings, and private-audio contracts remain unchanged. No estimated timestamps or additional provider calls are introduced.

## Shared vocabulary library (2026-10-17)

Migration `20261017140000_shared_vocabulary_library` adds an index over saved published clips. `VocabularyTerm` groups exact normalized spelling plus source language. `VocabularyMeaning` groups a term's normalized Armenian translation (not an inferred dictionary sense). `VocabularyRecording` references the existing immutable `AudioAsset` and narration, without copying bytes. `VocabularyUsage` records a release, occurrence, source lesson, and sentence. `VocabularyPreference` explicitly selects a recording for one meaning and voice, with the modifying admin and timestamp.

Publish indexes every released text, including the unchanged-publication path, in the same transaction. Repeated publication/backfill creates no duplicate usages, clips, or jobs. Translation edits retain historical meaning/usage records and reuse the same audio asset. Library references restrict deletion of the source assets and releases; archival remains supported. Do not delete audio files referenced by the library during storage cleanup.

Admin endpoints (authenticated admin only):

- `GET /api/admin/vocabulary?q=...&page=1`: search spelling or Armenian translation, 25 entries per page, including recording counts.
- `GET /api/admin/vocabulary/:termId`: meanings, recordings, availability, preferred choices, source sentences, and current/earlier lesson usages.
- `PUT /api/admin/vocabulary/meanings/:meaningId/preference`: `{ voiceId, recordingId: string | null, expectedRecordingId: string | null }`. Null clears the preference. Different meaning/voice or unavailable assets return 422. A concurrent preference change returns 409 rather than overwriting another admin's choice.

`GET /learner/words` substitutes a valid preferred clip only for matching indexed meaning and voice; otherwise it returns the original contextual clip. Existing mobile vocabulary playback consumes this unchanged response shape. Lesson manifests, repetitions within lessons, translations, and learner state identities are unchanged. The private audio endpoint permits a preferred asset only through an accessible publication containing the corresponding meaning/voice. Guessing another library asset ID does not grant access. Unpublishing the consuming lesson revokes its access as before. An explicitly shared preferred recording can still be used through another published lesson after its source lesson is withdrawn; it is now a retained library asset. Clearing a preference restores contextual audio on the next vocabulary refresh.

Existing publications can be indexed after migrating and building:

```sh
npm run vocabulary:backfill
npm run vocabulary:backfill -- --apply
```

The first command is a read-only inventory. The second applies idempotent indexing in batches, with one transaction per release. Run against the intended database and its existing `AUDIO_AUTHORING_STORAGE_ROOT`. It reads immutable release snapshots, verifies referenced clip bytes, skips legacy releases without snapshots, and stops on an invalid asset. It creates no files, audio jobs, provider requests, or new publications. After an interruption, correct the reported issue and rerun; completed releases are safe to revisit.

## Standalone vocabulary audio (2026-10-18)

After selecting words or phrases and saving Armenian translations, use **Check
vocabulary audio**. The preview lists saved recordings to reuse and distinct
missing words to generate. **Reuse saved audio & generate…** explicitly queues a
`GENERATE_VOCABULARY` job. Full lesson narration remains a separate operation.
Publishing never generates or extracts new word audio; missing word audio blocks
publication until preparation succeeds.

Reuse matches the normalized source phrase, source language, voice, and model.
An existing preferred recording for the Armenian meaning is tried first. A
recording for another meaning of the same phrase can share its audio while the
lesson keeps its own translation. New recordings use the existing ElevenLabs
adapter with only the selected word/phrase as input. They are saved as private
shared assets with no owning text, indexed in Vocabulary before publication,
and survive draft changes. Repeated occurrences and later lessons reuse the
same asset. Existing extracted recordings remain available for reuse and
historical publications are unchanged.

A unique durable `VocabularyAudio` reservation prevents simultaneous requests
from generating the same phrase and voice twice. Known safe provider failures
can be retried by an explicit admin action. An uncertain charge outcome remains
blocked for operator review. The worker renews its lease between words and
surfaces expired dispatches as uncertain failures after a restart. No automatic provider retries or migration-time
speech requests occur. Draft versions are checked before work and before
attaching results; late recordings remain in the library without changing an
edited draft.

API: `GET /api/admin/lessons/:lessonId/texts/:textId/vocabulary/audio-plan`;
`POST .../vocabulary/audio-jobs` with `{expectedDraftVersion}` and an
`Idempotency-Key` header. Existing `/api/admin/audio-jobs/:jobId` supplies progress
and a completion summary. `TextVocabularyEntry.recordingId` binds draft entries
to saved recordings. Published learning occurrences with
`clipSource: "VOCABULARY"` repeat the full saved clip; cut bounds still refer to
the original narration and determine where reading resumes. Older manifests
retain their existing playback behavior.

Apply both 2026-10-18 migrations before starting the updated backend and worker.
The enum addition is a separate migration so PostgreSQL commits it before the
new partial index uses the enum value. Existing library backfill remains
optional and never generates audio.

Learners can use **Mark all as unknown** in a lesson. The authenticated
`POST /api/learner/publications/:publicationId/activate-vocabulary` endpoint takes
`{clientUpdatedAt}` and atomically selects unmarked learning occurrences across
all texts in that pinned publication. It preserves learned states and newer
individual choices. The ordinary per-word controls continue to work, and no
background process reselects words after the learner removes them. The action
requires a connection; the client syncs queued individual choices first.
