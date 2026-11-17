import { Prisma, PrismaClient } from '@prisma/client';
import { lockText } from './authoringTransaction';
import { resolveAudioTiming, TIMING_ALGORITHM_VERSION } from './audioTiming';
import { sentenceAudioState, SentenceRecording } from './sentenceNarration';
import { TextAlignmentResult } from './textOccurrenceAlignment';
import { readAudioAssetRange } from './audioAssetStorage';
import { decodeWav } from './pcmWav';
import { mapSourceText, persistTextMap } from './textMap';
import { splitSentences } from './sentenceSegmentation';
import { inspectReaderDraft, ReaderReleaseError, validReaderAsset } from './readerRelease';
import { extractMissingClips } from './lessonPublication';

/** Rebuild only timing/derived clips. No code path here can generate speech. */
export async function refreshDraftTimings(prisma: PrismaClient, textId: string,
  repair?: {jobId: string; sentenceIndex?: number; expectedDraftVersion: number; contentRevisionId: string}) {
  const workspace = await prisma.textWorkspace.findUniqueOrThrow({ where: { textId } });
  const [revision, narration, oldAlignment] = await Promise.all([
    prisma.textContentRevision.findUnique({ where: { id: workspace.currentContentRevisionId ?? '' } }),
    prisma.textNarration.findUnique({ where: { id: workspace.currentNarrationId ?? '' }, include: { asset: true } }),
    prisma.textAlignment.findUnique({ where: { id: workspace.currentAlignmentId ?? '' }, include: { occurrences: { orderBy: { ordinal: 'asc' } } } }),
  ]);
  if (!revision || !narration || narration.contentRevisionId !== revision.id) {
    if (repair) throw new ReaderReleaseError(422, 'Prepare the existing sentence recordings before repairing timings.');
    return workspace;
  }
  if (repair && (workspace.draftVersion !== repair.expectedDraftVersion || revision.id !== repair.contentRevisionId))
    throw new ReaderReleaseError(409, 'The draft changed before timing repair. Reload and try again.');
  const validationKey = `${TIMING_ALGORITHM_VERSION}:${workspace.currentAlignmentId}`;
  const lineageMatches = oldAlignment?.contentRevisionId === revision.id && oldAlignment?.narrationId === narration.id;
  if (!repair && ((lineageMatches && (oldAlignment?.algorithmVersion === TIMING_ALGORITHM_VERSION || workspace.timingValidationKey === validationKey)) ||
      await prisma.audioJob.findFirst({ where: { textId, status: { in: ['QUEUED', 'RUNNING'] } } }))) return workspace;

  const settings = narration.requestSettings as { generationMode?: string };
  const sentenceOnly = settings.generationMode === 'sentence-assets';
  let mapping: TextAlignmentResult;
  let sentences: SentenceRecording[] | undefined;
  if (sentenceOnly) {
    const state = await sentenceAudioState(prisma, textId, revision.text, revision.sourceLanguage, narration.voiceId,
      workspace.sentenceEndOffsets as number[] | undefined ?? undefined, repair);
    mapping = state.mapping;
    sentences = state.sentences;
  } else {
    if (!validReaderAsset(narration.asset)) {
      if (repair) throw new ReaderReleaseError(422, 'The recording is missing or damaged. Restore it or generate new audio.');
      return workspace;
    }
    const audio = decodeWav(readAudioAssetRange(narration.asset.storageKey, 0, narration.asset.byteLength)!.buffer);
    if (repair) await prisma.audioJob.updateMany({ where: { id: repair.jobId, status: 'RUNNING' }, data: { leaseUntil: new Date(Date.now() + 5 * 60 * 1000) } });
    mapping = (await resolveAudioTiming(prisma, { assetId: narration.asset.id, text: revision.text, audio, alignment: narration.rawAlignment }, repair)).mapping;
    if (mapping.status !== 'OK') mapping = { ...mapSourceText(revision.text, splitSentences(revision.text, revision.sourceLanguage)), diagnostics: mapping.diagnostics };
  }
  return prisma.$transaction(async tx => {
    await lockText(tx, textId);
    const current = await tx.textWorkspace.findUniqueOrThrow({ where: { textId } });
    if (current.draftVersion !== workspace.draftVersion || current.currentNarrationId !== narration.id || current.currentContentRevisionId !== revision.id) {
      if (repair) throw new ReaderReleaseError(409, 'The draft changed. Repaired timing data is saved; reload to apply it.');
      return current;
    }
    if (!repair && await tx.audioJob.findFirst({ where: { textId, status: { in: ['QUEUED', 'RUNNING'] } } })) return current;
    if (repair) {
      await tx.$queryRaw`SELECT id FROM "AudioJob" WHERE id = ${repair.jobId} FOR UPDATE`;
      if (!(await tx.audioJob.findFirst({ where: { id: repair.jobId, textId, status: 'RUNNING' } })))
        throw new ReaderReleaseError(409, 'Timing repair is no longer active.');
    }
    const sameWords = lineageMatches && mapping.status === 'OK' && oldAlignment?.status === 'OK' && oldAlignment.occurrences.length === mapping.occurrences.length &&
      oldAlignment.occurrences.every((old, index) => {
        const word = mapping.occurrences[index];
        return old.charStart === word.charStart && old.charEnd === word.charEnd && old.surfaceText === word.surfaceText &&
          old.mappingStatus === word.mappingStatus && old.speechStartSample === word.speechStartSample && old.speechEndSample === word.speechEndSample;
      });
    if (sameWords) {
      // Validation must not churn word/release identities for already-correct audio.
      if (repair) await tx.audioJob.update({ where: { id: repair.jobId }, data: { status: 'SUCCEEDED', resultId: oldAlignment.id, leaseUntil: null } });
      return tx.textWorkspace.update({ where: { textId }, data: { timingValidationKey: validationKey } });
    }
    const updatedNarration = await tx.textNarration.create({ data: {
      textId, contentRevisionId: revision.id, assetId: narration.assetId, jobId: repair?.jobId ?? narration.jobId,
      provider: narration.provider, model: narration.model, voiceId: narration.voiceId, inputTextSha256: narration.inputTextSha256,
      rawAlignment: narration.rawAlignment ?? Prisma.JsonNull,
      requestSettings: sentences ? { ...(narration.requestSettings as object), sentences } as unknown as Prisma.InputJsonValue : narration.requestSettings!,
    } });
    const alignment = await persistTextMap(tx, revision, mapping, updatedNarration.id,
      sentences?.map(s => ({ startSample: s.startSample, endSample: s.endSample })));
    await tx.textWorkspace.update({ where: { textId }, data: { currentNarrationId: updatedNarration.id, currentAlignmentId: alignment.id,
      draftVersion: { increment: 1 }, approvedTextReleaseId: null, timingValidationKey: `${TIMING_ALGORITHM_VERSION}:${alignment.id}` } });
    if (repair) await tx.audioJob.update({ where: { id: repair.jobId }, data: { status: 'SUCCEEDED', resultId: alignment.id, leaseUntil: null } });
    // Repairing timings also restores derived word clips locally. Historical clips
    // and published releases retain their original IDs and exact bytes.
    if (mapping.status === 'OK') {
      const draft = await inspectReaderDraft(tx, textId);
      if (draft.readiness.narrationValid && draft.readiness.alignmentStatus === 'OK' && !draft.readiness.selectedMissingTranslationCount)
        await extractMissingClips(tx, draft);
    }
    return tx.textWorkspace.findUniqueOrThrow({ where: { textId } });
  }, { timeout: 60000 });
}
