import { AudioJob, Prisma, PrismaClient } from '@prisma/client';
import { lockText } from './authoringTransaction';
import { completeJob, createOrReplayJob, failJob } from './audioJobs';
import { ReaderReleaseError, validReaderAsset } from './readerRelease';
import { normalizeVocabulary } from './vocabularyLibrary';
import { resolveVocabularyRange } from './vocabularyRanges';
import { ELEVEN_LABS_MODEL, generateNarration, ProviderError } from './elevenLabsNarration';
import { encodeWav } from './pcmWav';
import { writeAudioAsset } from './audioAssetStorage';
import { config } from '../config';

type Db = Prisma.TransactionClient | PrismaClient;
type PlanEntry = { entryId: string; text: string; translation: string; language: string; recordingId: string | null; assetId: string | null };
export interface VocabularyAudioPayload { alignmentId: string; draftVersion: number; voiceId: string; entries: PlanEntry[] }

export async function vocabularyAudioPlan(db: Db, textId: string) {
  const workspace = await db.textWorkspace.findUniqueOrThrow({ where: { textId } });
  const [alignment, narration, revision, entries] = await Promise.all([
    db.textAlignment.findUnique({ where: { id: workspace.currentAlignmentId ?? '' }, include: { occurrences: { orderBy: { ordinal: 'asc' } } } }),
    db.textNarration.findUnique({ where: { id: workspace.currentNarrationId ?? '' } }),
    db.textContentRevision.findUnique({ where: { id: workspace.currentContentRevisionId ?? '' } }),
    db.textVocabularyEntry.findMany({ where: { textId, alignmentId: workspace.currentAlignmentId ?? '', archivedAt: null, selected: true }, include: { translations: true } }),
  ]);
  if (!alignment || alignment.status !== 'OK' || !narration || !revision || narration.contentRevisionId !== revision.id || alignment.narrationId !== narration.id)
    throw new ReaderReleaseError(422, 'Generate and align the current narration before preparing word audio.');
  const language = revision.sourceLanguage.trim().toLowerCase();
  const result: PlanEntry[] = [];
  for (const entry of entries) {
    const translation = entry.translations.find(t => ['hy', 'am'].includes(t.languageCode))?.translation.trim();
    if (!translation) throw new ReaderReleaseError(422, 'Add Armenian translations for all selected words and phrases first.');
    const range = resolveVocabularyRange(alignment.occurrences, entry);
    const text = revision.text.slice(range.first.charStart, range.last.charEnd);
    const term = await db.vocabularyTerm.findUnique({ where: { language_normalizedText: { language, normalizedText: normalizeVocabulary(text) } }, include: {
      meanings: { include: { preferences: true, recordings: { where: { voiceId: narration.voiceId, model: ELEVEN_LABS_MODEL }, orderBy: [{ standalone: 'desc' }, { createdAt: 'asc' }], include: { asset: true } } } },
    } });
    const sameMeaning = term?.meanings.find(m => m.normalizedTranslation === normalizeVocabulary(translation));
    const preferredId = sameMeaning?.preferences.find(p => p.voiceId === narration.voiceId)?.recordingId;
    const candidates = [...(sameMeaning?.recordings ?? []), ...(term?.meanings.flatMap(m => m.recordings) ?? [])];
    const recording = [candidates.find(r => r.id === preferredId), ...candidates].find(r => r && validReaderAsset(r.asset));
    result.push({ entryId: entry.id, text, translation, language, recordingId: recording?.id ?? null, assetId: recording?.assetId ?? null });
  }
  const missing = [...new Set(result.filter(e => !e.recordingId).map(e => normalizeVocabulary(e.text)))];
  return { alignmentId: alignment.id, draftVersion: workspace.draftVersion, voiceId: narration.voiceId, entries: result,
    reuseCount: result.filter(e => e.recordingId).length, generateCount: missing.length,
    audioGenerationConfigured: Boolean(config.elevenLabs.apiKey),
  };
}

export async function requestVocabularyAudio(prisma: PrismaClient, textId: string, actorId: string, idempotencyKey: string, expectedDraftVersion: number) {
  return prisma.$transaction(async tx => {
    await lockText(tx, textId);
    // Replay must work even after a successful job has advanced the draft.
    const existing = await tx.audioJob.findUnique({ where: { textId_kind_idempotencyKey: { textId, kind: 'GENERATE_VOCABULARY', idempotencyKey } } });
    if (existing) {
      if ((existing.requestPayload as unknown as VocabularyAudioPayload).draftVersion !== expectedDraftVersion)
        throw new ReaderReleaseError(409, 'Idempotency key reused with a different draft.');
      return { job: existing, replay: true };
    }
    const plan = await vocabularyAudioPlan(tx, textId);
    if (plan.draftVersion !== expectedDraftVersion) throw new ReaderReleaseError(409, 'The text changed. Check vocabulary audio again.');
    if (!plan.entries.length) throw new ReaderReleaseError(422, 'Select at least one learning word or phrase.');
    if (plan.generateCount && !plan.audioGenerationConfigured) throw new ReaderReleaseError(503, 'Word audio generation is not configured. Existing recordings can still be reused.');
    const payload: VocabularyAudioPayload = { alignmentId: plan.alignmentId, draftVersion: plan.draftVersion, voiceId: plan.voiceId, entries: plan.entries };
    return createOrReplayJob(tx, { textId, actorId, idempotencyKey, kind: 'GENERATE_VOCABULARY', requestPayload: payload,
      reservedCharacters: [...new Map(plan.entries.filter(e => !e.recordingId).map(e => [normalizeVocabulary(e.text), e.text])).values()].reduce((sum, text) => sum + text.length, 0) });
  }, { timeout: 60000 });
}

async function ensureMeaning(tx: Prisma.TransactionClient, entry: PlanEntry) {
  const normalizedText = normalizeVocabulary(entry.text);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`vocabulary:${entry.language}:${normalizedText}`}, 0))`;
  const term = await tx.vocabularyTerm.upsert({ where: { language_normalizedText: { language: entry.language, normalizedText } },
    create: { language: entry.language, normalizedText, displayText: entry.text }, update: {} });
  const normalizedTranslation = normalizeVocabulary(entry.translation);
  const meaning = await tx.vocabularyMeaning.upsert({ where: { termId_normalizedTranslation: { termId: term.id, normalizedTranslation } },
    create: { termId: term.id, translation: entry.translation, normalizedTranslation }, update: {} });
  return { term, meaning };
}

async function recordingFor(prisma: PrismaClient, job: AudioJob, entry: PlanEntry, voiceId: string) {
  const reserved = await prisma.$transaction(async tx => {
    const { term, meaning } = await ensureMeaning(tx, entry);
    const candidates = await tx.vocabularyRecording.findMany({ where: { meaning: { termId: term.id }, voiceId, model: ELEVEN_LABS_MODEL },
      orderBy: [{ standalone: 'desc' }, { createdAt: 'asc' }], include: { asset: true } });
    const chosen = [candidates.find(c => c.id === entry.recordingId), ...candidates].find(c => c && validReaderAsset(c.asset));
    if (chosen) {
      const recording = await tx.vocabularyRecording.upsert({ where: { meaningId_assetId: { meaningId: meaning.id, assetId: chosen.assetId } },
        create: { meaningId: meaning.id, assetId: chosen.assetId, narrationId: chosen.narrationId, standalone: chosen.standalone, voiceId, model: chosen.model }, update: {} });
      return { recording };
    }
    const key = { termId: term.id, voiceId, model: ELEVEN_LABS_MODEL };
    const previous = await tx.vocabularyAudio.findUnique({ where: { termId_voiceId_model: key }, include: { asset: true } });
    if (previous?.status === 'SUCCEEDED') {
      if (!validReaderAsset(previous.asset)) throw new ReaderReleaseError(422, 'Saved word audio is unavailable. Review the vocabulary recording before generating again.');
      const recording = await tx.vocabularyRecording.upsert({ where: { meaningId_assetId: { meaningId: meaning.id, assetId: previous.asset!.id } },
        create: { meaningId: meaning.id, assetId: previous.asset!.id, voiceId, model: ELEVEN_LABS_MODEL, standalone: true }, update: {} });
      return { recording };
    }
    if (previous && !(previous.status === 'FAILED' && previous.retryable))
      throw new ReaderReleaseError(409, previous.status === 'RUNNING' ? 'Word audio is already being generated. Wait, then check again.' : 'A previous audio request has an uncertain outcome. Review it before generating again.');
    const reservation = await tx.vocabularyAudio.upsert({ where: { termId_voiceId_model: key },
      create: { ...key, ownerJobId: job.id, status: 'RUNNING' }, update: { ownerJobId: job.id, status: 'RUNNING', errorCode: null, retryable: false } });
    return { reservation, meaningId: meaning.id, termId: term.id };
  });
  if (reserved.recording) return { recording: reserved.recording, generated: false };
  const reservation = reserved.reservation!;
  try {
    const result = await generateNarration({ text: entry.text, voiceId }, { apiKey: config.elevenLabs.apiKey });
    const written = await writeAudioAsset({ textId: `vocabulary-${reserved.termId}`, kind: 'WORD_CLIP', bytes: encodeWav(result.audio) });
    const recording = await prisma.$transaction(async tx => {
      const asset = await tx.audioAsset.create({ data: { ...written, kind: 'WORD_CLIP', mimeType: 'audio/wav', sampleRate: result.audio.sampleRate,
        channels: result.audio.channels, bitDepth: result.audio.bitsPerSample, frameCount: result.audio.frameCount, state: 'READY' } });
      await tx.vocabularyAudio.update({ where: { id: reservation.id }, data: { assetId: asset.id, status: 'SUCCEEDED' } });
      return tx.vocabularyRecording.create({ data: { meaningId: reserved.meaningId!, assetId: asset.id, standalone: true, voiceId, model: ELEVEN_LABS_MODEL } });
    });
    return { recording, generated: true };
  } catch (error) {
    await prisma.vocabularyAudio.update({ where: { id: reservation.id }, data: { status: 'FAILED',
      errorCode: error instanceof ProviderError ? error.code : 'PROVIDER_UNKNOWN_OUTCOME', retryable: error instanceof ProviderError && !error.possibleCharge } });
    throw error;
  }
}

export async function runGenerateVocabularyJob(prisma: PrismaClient, job: AudioJob) {
  const payload = job.requestPayload as unknown as VocabularyAudioPayload;
  try {
    const workspace = await prisma.textWorkspace.findUniqueOrThrow({ where: { textId: job.textId } });
    if (workspace.currentAlignmentId !== payload.alignmentId || workspace.draftVersion !== payload.draftVersion)
      throw new ReaderReleaseError(409, 'The draft changed. Check vocabulary audio again.');
    const prepared: { entryId: string; recordingId: string }[] = [];
    let generatedCount = 0;
    for (const entry of payload.entries) {
      // Each provider request is bounded to two minutes. Renew between words
      // so long batches stay live while crashed dispatches can be surfaced.
      await prisma.audioJob.update({ where: { id: job.id }, data: { leaseUntil: new Date(Date.now() + 5 * 60 * 1000) } });
      const result = await recordingFor(prisma, job, entry, payload.voiceId);
      if (result.generated) generatedCount++;
      prepared.push({ entryId: entry.entryId, recordingId: result.recording.id });
    }
    await prisma.$transaction(async tx => {
      await lockText(tx, job.textId);
      const current = await tx.textWorkspace.findUniqueOrThrow({ where: { textId: job.textId } });
      if (current.currentAlignmentId !== payload.alignmentId || current.draftVersion !== payload.draftVersion)
        throw new ReaderReleaseError(409, 'The draft changed. Audio is saved in the vocabulary library; check again to attach it.');
      for (const entry of prepared) await tx.textVocabularyEntry.update({ where: { id: entry.entryId }, data: { recordingId: entry.recordingId } });
      await tx.textWorkspace.update({ where: { textId: job.textId }, data: { draftVersion: { increment: 1 } } });
      await completeJob(tx, job.id, { resultId: JSON.stringify({ generatedCount, reusedCount: prepared.length - generatedCount }) });
    });
  } catch (error) {
    await failJob(prisma, job.id, { code: error instanceof ProviderError ? error.code : 'VOCABULARY_AUDIO_FAILED',
      message: error instanceof Error ? error.message : 'Unable to prepare word audio', retryable: error instanceof ProviderError && error.retryable });
  }
}
