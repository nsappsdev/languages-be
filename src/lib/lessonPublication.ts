import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { lockLesson } from './authoringTransaction';
import { inspectReaderDraft, ReaderReleaseError, readerAssetIds } from './readerRelease';
import { computeRequestHash } from './audioJobs';
import { decodeWav, encodeWav } from './pcmWav';
import { extractWordClip } from './wordClipExtraction';
import { readAudioAssetRange, writeAudioAsset } from './audioAssetStorage';
import { ReaderManifest, ReaderText } from '../types/reader';
import { indexPublishedVocabulary } from './vocabularyLibrary';

type Draft = Awaited<ReturnType<typeof inspectReaderDraft>>;

// Compatibility for already queued legacy extraction jobs and historical fixtures.
// New lesson publication never calls this function. Files are immutable;
// an interrupted transaction may leave unreferenced files for a later audited cleanup.
export async function extractMissingClips(tx: Prisma.TransactionClient, draft: Draft) {
  if (!draft.readiness.narrationValid || draft.readiness.alignmentStatus !== 'OK' || draft.readiness.selectedMissingTranslationCount || !draft.narration || !draft.alignment) throw new ReaderReleaseError(422, 'Text is not ready');
  if (!draft.missingClipOccurrenceIds.length) return;
  const narration = draft.narration;
  const stored = readAudioAssetRange(narration.asset.storageKey, 0, narration.asset.byteLength);
  if (!stored) throw new ReaderReleaseError(422, 'Narration audio is unavailable');
  const decoded = decodeWav(stored.buffer);
  if (decoded.frameCount !== narration.asset.frameCount || decoded.sampleRate !== narration.asset.sampleRate)
    throw new ReaderReleaseError(422, 'Narration audio metadata is inconsistent');
  for (const occurrenceId of draft.missingClipOccurrenceIds) {
    const cut = draft.vocabularyCuts.get(occurrenceId)!;
    const entry = await tx.textVocabularyEntry.findUniqueOrThrow({ where: { alignmentId_occurrenceId: { alignmentId: draft.alignment.id, occurrenceId } } });
    const clip = extractWordClip(decoded, cut.startSample, cut.endSample);
    const written = await writeAudioAsset({ textId: narration.textId, kind: 'WORD_CLIP', bytes: encodeWav(clip) });
    const asset = await tx.audioAsset.create({ data: { textId: narration.textId, kind: 'WORD_CLIP',
      ...written, mimeType: 'audio/wav', sampleRate: clip.sampleRate, channels: clip.channels,
      bitDepth: clip.bitsPerSample, frameCount: clip.frameCount, state: 'READY' } });
    const data = { textId: narration.textId, narrationId: narration.id, alignmentId: draft.alignment.id,
      occurrenceId, entryId: entry.id, assetId: asset.id, startSample: cut.startSample, endSample: cut.endSample };
    await tx.wordClip.upsert({ where: { occurrenceId_extractionVersion: { occurrenceId, extractionVersion: 1 } }, create: data, update: data });
    await tx.wordOccurrence.update({ where: { id: occurrenceId }, data: { cutStartSample: cut.startSample, cutEndSample: cut.endSample } });
  }
}

export async function publishLesson(prisma: PrismaClient, lessonId: string, actorId: string) {
  return prisma.$transaction(async tx => {
    await lockLesson(tx, lessonId);
    const lesson = await tx.lesson.findUniqueOrThrow({ where: { id: lessonId }, include: {
      items: { where: { archivedAt: null }, orderBy: { order: 'asc' }, select: { id: true, order: true } },
    } });
    if (!lesson.items.length) throw new ReaderReleaseError(422, 'Add at least one text', { code: 'LESSON_NOT_READY', texts: [] });
    const drafts = await Promise.all(lesson.items.map(item => inspectReaderDraft(tx, item.id)));
    const errors = drafts.flatMap((draft, i) => draft.readiness.canPublish ? [] : [{ textId: lesson.items[i].id, order: lesson.items[i].order, readiness: draft.readiness }]);
    if (errors.length) throw new ReaderReleaseError(422, 'Complete the highlighted texts before publishing', { code: 'LESSON_NOT_READY', texts: errors });
    const previous = lesson.currentPublicationId ? await tx.lessonPublication.findUnique({ where: { id: lesson.currentPublicationId } }) : null;
    const previousTexts = previous && !previous.revokedAt ? (previous.manifest as unknown as ReaderManifest).texts : [];
    const texts: ReaderText[] = [];
    for (const [index, draft] of drafts.entries()) {
      const textId = lesson.items[index].id;
      const current = draft;
      if (!current.snapshot || !current.readiness.readyForPublication)
        throw new ReaderReleaseError(422, 'Text is not ready', { code: 'LESSON_NOT_READY', texts: [{ textId, order: lesson.items[index].order, readiness: current.readiness }] });
      const old = previousTexts.find(t => t.textId === textId);
      // Unchanged texts reuse their release identity and learner progress.
      if (old && computeRequestHash({ ...old, textReleaseId: '' }) === computeRequestHash(current.snapshot)) { texts.push(old); continue; }
      const id = crypto.randomUUID();
      const snapshot = { ...current.snapshot, textReleaseId: id };
      await tx.textRelease.create({ data: { id, textId, contentRevisionId: snapshot.contentRevisionId,
        narrationId: snapshot.narrationId, alignmentId: snapshot.alignmentId, entryIds: current.readiness.eligibleEntryIds,
        readinessSnapshot: current.readiness as unknown as Prisma.InputJsonValue,
        manifestSnapshot: snapshot as unknown as Prisma.InputJsonValue, authorId: actorId } });
      texts.push(snapshot);
    }
    const manifest: ReaderManifest = { schemaVersion: 2, lessonId, title: lesson.title, description: lesson.description, texts };
    // Include the reuse path so existing publications can be indexed without
    // creating new releases or audio files.
    await indexPublishedVocabulary(tx, lessonId, texts);
    if (previous && !previous.revokedAt && computeRequestHash(previous.manifest) === computeRequestHash(manifest))
      return { publicationId: previous.id, replay: true };
    const created = await tx.lessonPublication.create({ data: { lessonId, authorId: actorId,
      manifest: manifest as unknown as Prisma.InputJsonValue, assetIds: [...new Set(texts.flatMap(readerAssetIds))] } });
    await tx.lesson.update({ where: { id: lessonId }, data: { currentPublicationId: created.id, publishedAt: new Date() } });
    return { publicationId: created.id, replay: false };
  }, { timeout: 60000, maxWait: 60000 });
}
