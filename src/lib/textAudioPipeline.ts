import { AudioJob, PrismaClient } from '@prisma/client';
import { generateNarration, ProviderError } from './elevenLabsNarration';
import { buildTextAlignment, type ElevenLabsCharacterAlignment } from './textOccurrenceAlignment';
import { encodeWav } from './pcmWav';
import { writeAudioAsset } from './audioAssetStorage';
import { completeJob, failJob } from './audioJobs';
import { config } from '../config';
import { lockText } from './authoringTransaction';
import { inspectReaderDraft } from './readerRelease';
import { extractMissingClips } from './lessonPublication';

/**
 * Executes one claimed AudioJob to completion (success or terminal failure).
 * This is the single place a paid provider call can be dispatched from.
 */

export interface GenerateNarrationPayload {
  contentRevisionId: string;
  voiceId: string;
}

export interface ExtractClipsPayload {
  narrationId: string;
  alignmentId: string;
  occurrenceIds: string[];
}

export async function runGenerateNarrationJob(prisma: PrismaClient, job: AudioJob) {
  const payload = job.requestPayload as unknown as GenerateNarrationPayload;

  const contentRevision = await prisma.textContentRevision.findUnique({ where: { id: payload.contentRevisionId } });
  if (!contentRevision || contentRevision.textId !== job.textId) {
    await failJob(prisma, job.id, { code: 'CONTENT_REVISION_NOT_FOUND', message: 'Saved text revision no longer exists', retryable: false });
    return;
  }

  let result;
  try {
    result = await generateNarration(
      { text: contentRevision.text, voiceId: payload.voiceId },
      { apiKey: config.elevenLabs.apiKey },
    );
  } catch (error) {
    if (error instanceof ProviderError) {
      await failJob(prisma, job.id, { code: error.code, message: error.message, retryable: error.retryable });
      return;
    }
    await failJob(prisma, job.id, {
      code: 'PROVIDER_UNKNOWN_OUTCOME',
      message: error instanceof Error ? error.message : 'Unknown narration generation failure',
      retryable: false,
    });
    return;
  }

  const wavBytes = encodeWav(result.audio);
  const written = await writeAudioAsset({ textId: job.textId, kind: 'NARRATION', bytes: wavBytes });

  await prisma.$transaction(async (tx) => {
    await lockText(tx, job.textId);
    const asset = await tx.audioAsset.create({
      data: {
        textId: job.textId,
        kind: 'NARRATION',
        storageKey: written.storageKey,
        mimeType: 'audio/wav',
        byteLength: written.byteLength,
        sha256: written.sha256,
        sampleRate: result.audio.sampleRate,
        channels: result.audio.channels,
        bitDepth: result.audio.bitsPerSample,
        frameCount: result.audio.frameCount,
        state: 'READY',
      },
    });

    const narration = await tx.textNarration.create({
      data: {
        textId: job.textId,
        contentRevisionId: contentRevision.id,
        assetId: asset.id,
        jobId: job.id,
        provider: 'elevenlabs',
        model: 'eleven_multilingual_v2',
        voiceId: payload.voiceId,
        requestSettings: { outputFormat: 'wav_24000' },
        inputTextSha256: contentRevision.textSha256,
        rawAlignment: (result.alignment ?? null) as any,
      },
    });

    const mapping = buildTextAlignment({
      text: contentRevision.text,
      alignment: result.alignment as ElevenLabsCharacterAlignment | null,
      algorithmVersion: 1,
      sampleRate: result.audio.sampleRate,
    });

    const sentencesWithIds = mapping.sentences.map((sentence, index) => ({
      id: `sentence-${index}`,
      ...sentence,
    }));

    const alignment = await tx.textAlignment.create({
      data: {
        textId: job.textId,
        contentRevisionId: contentRevision.id,
        narrationId: narration.id,
        algorithmVersion: 1,
        status: mapping.status,
        sentences: sentencesWithIds as any,
        diagnostics: mapping.diagnostics as any,
      },
    });

    if (mapping.occurrences.length) {
      await tx.wordOccurrence.createMany({
        data: mapping.occurrences.map((occurrence) => ({
          alignmentId: alignment.id,
          ordinal: occurrence.ordinal,
          sentenceId: sentencesWithIds[occurrence.sentenceIndex]?.id ?? 'unassigned',
          charStart: occurrence.charStart,
          charEnd: occurrence.charEnd,
          surfaceText: occurrence.surfaceText,
          normalizedText: occurrence.normalizedText,
          speechStartSample: occurrence.speechStartSample,
          speechEndSample: occurrence.speechEndSample,
          mappingStatus: occurrence.mappingStatus,
        })),
      });
    }

    // A completed job belongs to its saved revision, even if the admin has edited meanwhile.
    await tx.textWorkspace.updateMany({
      where: { textId: job.textId, currentContentRevisionId: contentRevision.id },
      data: { currentNarrationId: narration.id, currentAlignmentId: alignment.id, approvedTextReleaseId: null, draftVersion: { increment: 1 } },
    });

    await completeJob(tx, job.id, { resultAssetId: asset.id, resultId: alignment.id });
  });
}

// Kept for already queued local extraction jobs during rollout; publication now
// performs extraction directly. Old jobs cannot attach clips to a new narration.
export async function runExtractClipsJob(prisma: PrismaClient, job: AudioJob) {
  const payload = job.requestPayload as unknown as ExtractClipsPayload;
  try {
    await prisma.$transaction(async tx => {
      await lockText(tx, job.textId);
      const draft = await inspectReaderDraft(tx, job.textId);
      if (draft.workspace.currentNarrationId !== payload.narrationId || draft.workspace.currentAlignmentId !== payload.alignmentId)
        throw new Error('Narration changed. These clips are obsolete.');
      await extractMissingClips(tx, { ...draft, missingClipOccurrenceIds: draft.missingClipOccurrenceIds.filter(id => payload.occurrenceIds.includes(id)) });
      await completeJob(tx, job.id, {});
    }, { timeout: 60000 });
  } catch (error) {
    await failJob(prisma, job.id, { code: 'CLIP_EXTRACTION_FAILED', message: error instanceof Error ? error.message : 'Clip extraction failed', retryable: false });
  }
}
