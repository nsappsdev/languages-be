# Lesson reader appearance

Admin **App Settings → Lesson reader appearance** manages global English and Armenian reading defaults. The settings apply when a learner opens or reopens a lesson. Vocabulary, profile, navigation and other app typography stay independent. Appearance changes do not regenerate narration or alter immutable lesson publications.

## Font library

Upload a labelled TTF or OTF file (up to 3 MiB). The API parses the font and checks its complete English and Armenian alphabet coverage; a font must support at least one alphabet. Admin only offers each font for the alphabets it supports. Each file is one selectable face. Upload regular/bold files separately; variable fonts use their default face.

Files are deduplicated by SHA-256 and stored under immutable hash filenames. Uploading the same bytes returns the existing catalog entry and repairs a missing file, without replacing its label or archive state. Rename affects the display label. Archive/restore is reversible; selected fonts cannot be archived until a replacement is saved. Archived files remain downloadable for already-open readers. There is no physical font deletion endpoint.

Use fonts licensed for distribution in the app. The integration-test fixture is Noto Sans Armenian under its included OFL license.

## API

All routes require bearer authentication. Catalog mutations and settings writes require an admin role.

| Method | Path (under `/api`) | Purpose |
| --- | --- | --- |
| GET | `/admin/reader-fonts` | Catalog, availability, alphabet support and `inUse` |
| POST | `/admin/reader-fonts` | JSON `{label, fileName, base64}` |
| PATCH | `/admin/reader-fonts/:id` | `{label?, archived?}` |
| GET | `/reader-fonts/:id/content` | Authenticated TTF/OTF bytes, private immutable cache, ETag/304 |
| GET | `/settings` | Current settings plus selected `readerFonts.mainText` and `.translation` metadata |
| PATCH | `/settings` | Partial settings update; appearance controls send only appearance fields |

New appearance fields:

| Field | Bounds / meaning |
| --- | --- |
| `mainTextFontId`, `translationFontId` | Active catalog ID or `null` for device font |
| `mainTextFontSize` | Integer 12–32 points |
| `mainTextLineHeight`, `translationLineHeight` | Font-size multiplier, 1–2.5 |
| `translationFontMinSize` | Integer 6–20 points |
| `translationFontMaxSize`, `translationFontSize` | Integer 6–24 points; admin writes legacy size equal to maximum |
| `translationLetterSpacingMin`, `translationLetterSpacingMax` | −2 to 4 points |
| `translationGap` | 0–32 points between translation lane and English text |
| `readingRowGap` | 0–48 points between wrapped rows |
| `expectedUpdatedAt` | Optional concurrency guard; stale save returns 409 |

Minimum sizes/spacing cannot exceed their maxima, including partial PATCH requests. Selecting a custom font sets its legacy family string to `System`, so older clients keep a device-font fallback. The upgraded client loads fonts by ID and SHA identity, caches native files, and falls back to System with a notice if loading fails. Translations fit using measured glyph widths while retaining the configured minimum/maximum sizes. System accessibility font scaling remains enabled.

## Deployment

1. Apply additive migrations with `prisma migrate deploy` before the new backend starts. The follow-up migration preserves existing translation lane heights; new gap defaults are 2 and 4 points.
2. Persist `READER_FONT_STORAGE_ROOT` (default `./var/reader-fonts`). The Compose mount is `/opt/nsapp/data/reader-fonts:/app/var/reader-fonts`. Create the host directory with write access for the container's `node` user (UID/GID 1000); back it up together with the database. Multiple API instances must share this storage.
3. Release backend, then admin and upgraded mobile. Existing mobile builds continue using legacy device-font settings; custom font loading and new spacing controls need the upgraded mobile build.
4. Upload and choose fonts in admin, save reader appearance, and reopen a lesson to verify on iOS and Android. Font files are served through the authenticated API, not a public media directory.

## Verification

`npm test` covers backend unit checks. Compile and run `dist/integration/__tests__/readerAppearance.test.js` only against a guarded local disposable PostgreSQL database, as required by the integration helpers. It checks real font parsing, authorization, deduplication, content delivery, partial-range validation, stale saves and archive/selection concurrency. No paid speech generation is used.
