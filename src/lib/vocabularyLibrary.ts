import { Prisma, PrismaClient } from '@prisma/client';
import { ReaderReleaseError, validReaderAsset } from './readerRelease';
import { ReaderAsset, ReaderText } from '../types/reader';

type Db = Prisma.TransactionClient | PrismaClient;
export const normalizeVocabulary = (value: string) => value.normalize('NFC').replace(/[’‘]/g, "'").trim().replace(/\s+/gu, ' ').toLowerCase();
export const vocabularyUsageKey = (releaseId: string, occurrenceId: string) => `${releaseId}:${occurrenceId}`;
const assetDto = (asset: { id: string; sha256: string; mimeType: string; byteLength: number; sampleRate: number | null; frameCount: number | null }): ReaderAsset => ({
  id: asset.id, sha256: asset.sha256, mimeType: asset.mimeType, byteLength: asset.byteLength, sampleRate: asset.sampleRate!, frameCount: asset.frameCount!,
});

/** Index existing immutable audio by reference. No file writes, extraction, or TTS. */
export async function indexPublishedVocabulary(tx: Prisma.TransactionClient, lessonId: string, input: ReaderText | ReaderText[]) {
  const texts = Array.isArray(input) ? input : [input];
  const narrations = await tx.textNarration.findMany({ where: { id: { in: texts.map(text => text.narrationId) } } });
  const words = texts.flatMap(text => text.occurrences.filter(o => o.learning).map(word => ({ text, word })));
  // New terms have no row to lock yet. Prisma's empty-update upsert can race
  // on first insert, so serialize by natural key across all lesson texts.
  // Acquire in one global order to avoid reversed-text publication deadlocks.
  const termKeys = [...new Set(words.map(({ text, word }) => `${text.sourceLanguage.trim().toLowerCase()}:${normalizeVocabulary(word.text)}`))].sort();
  for (const key of termKeys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`vocabulary:${key}`}, 0))`;
  for (const { text, word } of words) {
    const narration = narrations.find(n => n.id === text.narrationId);
    if (!narration || narration.textId !== text.textId) throw new Error('Vocabulary narration does not belong to this text');
    const learning = word.learning!;
    const translation = learning.translations.find(t => ['hy', 'am'].includes(t.languageCode))?.translation.trim();
    if (!translation) continue;
    const asset = await tx.audioAsset.findUniqueOrThrow({ where: { id: learning.clip.id } });
    if (asset.textId !== text.textId || asset.kind !== 'WORD_CLIP' || asset.sha256 !== learning.clip.sha256 || !validReaderAsset(asset))
      throw new Error('Vocabulary clip does not match its published source');
    const language = text.sourceLanguage.trim().toLowerCase();
    const normalizedText = normalizeVocabulary(word.text);
    const term = await tx.vocabularyTerm.upsert({ where: { language_normalizedText: { language, normalizedText } },
      create: { language, normalizedText, displayText: word.text }, update: {} });
    const normalizedTranslation = normalizeVocabulary(translation);
    const meaning = await tx.vocabularyMeaning.upsert({ where: { termId_normalizedTranslation: { termId: term.id, normalizedTranslation } },
      create: { termId: term.id, translation, normalizedTranslation }, update: {} });
    const recording = await tx.vocabularyRecording.upsert({ where: { meaningId_assetId: { meaningId: meaning.id, assetId: asset.id } },
      create: { meaningId: meaning.id, assetId: asset.id, narrationId: narration.id, voiceId: narration.voiceId, model: narration.model }, update: {} });
    await tx.vocabularyUsage.upsert({ where: { textReleaseId_occurrenceId: { textReleaseId: text.textReleaseId, occurrenceId: word.id } },
      create: { recordingId: recording.id, lessonId, textReleaseId: text.textReleaseId, occurrenceId: word.id,
        sentence: text.sentences.find(s => s.id === word.sentenceId)?.text ?? '' }, update: {} });
  }
}

export async function vocabularyDetail(db: Db, id: string) {
  const term = await db.vocabularyTerm.findUnique({ where: { id }, include: { meanings: { orderBy: { translation: 'asc' }, include: {
    preferences: true,
    recordings: { orderBy: { createdAt: 'asc' }, include: { asset: true, usages: { include: {
      lesson: { select: { id: true, title: true, currentPublicationId: true } }, textRelease: { select: { textId: true } },
    } } } },
  } } } });
  if (!term) throw new ReaderReleaseError(404, 'Vocabulary entry not found');
  const publicationIds = [...new Set(term.meanings.flatMap(m => m.recordings.flatMap(r => r.usages.flatMap(u => u.lesson.currentPublicationId ? [u.lesson.currentPublicationId] : []))))];
  const publications = await db.lessonPublication.findMany({ where: { id: { in: publicationIds }, revokedAt: null }, select: { manifest: true } });
  const currentReleases = new Set(publications.flatMap(p => (p.manifest as unknown as { texts: ReaderText[] }).texts.map(t => t.textReleaseId)));
  return { id: term.id, text: term.displayText, language: term.language, meanings: term.meanings.map(meaning => ({
    id: meaning.id, translation: meaning.translation,
    preferences: meaning.preferences.map(p => ({ voiceId: p.voiceId, recordingId: p.recordingId })),
    recordings: meaning.recordings.map(recording => ({ id: recording.id, voiceId: recording.voiceId, model: recording.model,
      asset: assetDto(recording.asset), available: validReaderAsset(recording.asset),
      usages: recording.usages.map(usage => ({ lessonId: usage.lessonId, lessonTitle: usage.lesson.title,
        textId: usage.textRelease.textId, textReleaseId: usage.textReleaseId, occurrenceId: usage.occurrenceId,
        sentence: usage.sentence, current: currentReleases.has(usage.textReleaseId) })),
    })),
  })) };
}

export async function setVocabularyPreference(prisma: PrismaClient, input: {
  meaningId: string; voiceId: string; recordingId: string | null; expectedRecordingId: string | null; actorId: string;
}) {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "VocabularyMeaning" WHERE id = ${input.meaningId} FOR UPDATE`;
    if (!rows.length) throw new ReaderReleaseError(404, 'Meaning not found');
    const key = { meaningId: input.meaningId, voiceId: input.voiceId };
    const previous = await tx.vocabularyPreference.findUnique({ where: { meaningId_voiceId: key } });
    if ((previous?.recordingId ?? null) !== input.expectedRecordingId)
      throw new ReaderReleaseError(409, 'The preferred recording changed. Reload and choose again.');
    if (!input.recordingId) {
      await tx.vocabularyPreference.deleteMany({ where: key });
      return;
    }
    const recording = await tx.vocabularyRecording.findUnique({ where: { id: input.recordingId }, include: { asset: true } });
    if (!recording || recording.meaningId !== input.meaningId || recording.voiceId !== input.voiceId)
      throw new ReaderReleaseError(422, 'Choose a recording with the same meaning and voice.');
    if (!validReaderAsset(recording.asset)) throw new ReaderReleaseError(422, 'This recording is unavailable. Choose another recording.');
    await tx.vocabularyPreference.upsert({ where: { meaningId_voiceId: key },
      create: { ...key, recordingId: recording.id, updatedBy: input.actorId },
      update: { recordingId: recording.id, updatedBy: input.actorId } });
  });
}

/** Used only by standalone vocabulary playback; lesson manifests stay immutable. */
export async function preferredVocabularyClips(db: Db, texts: ReaderText[]) {
  const usages = await db.vocabularyUsage.findMany({ where: { textReleaseId: { in: texts.map(t => t.textReleaseId) } }, include: {
    recording: { include: { meaning: { include: { preferences: { include: { recording: { include: { asset: true } } } } } } } },
  } });
  const result = new Map<string, ReaderAsset>();
  const checked = new Map<string, boolean>();
  for (const usage of usages) {
    const preferred = usage.recording.meaning.preferences.find(p => p.voiceId === usage.recording.voiceId)?.recording;
    if (!preferred || preferred.meaningId !== usage.recording.meaningId || preferred.voiceId !== usage.recording.voiceId) continue;
    if (!checked.has(preferred.assetId)) checked.set(preferred.assetId, validReaderAsset(preferred.asset));
    if (checked.get(preferred.assetId)) result.set(vocabularyUsageKey(usage.textReleaseId, usage.occurrenceId), assetDto(preferred.asset));
  }
  return result;
}
