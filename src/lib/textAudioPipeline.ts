import { AudioJob, PrismaClient } from '@prisma/client';
import { generateNarration, ProviderError } from './elevenLabsNarration';
import { buildTextAlignment, type ElevenLabsCharacterAlignment } from './textOccurrenceAlignment';
import { encodeWav, decodeWav } from './pcmWav';
import { writeAudioAsset } from './audioAssetStorage';
import { computeContiguousCutBoundaries, extractWordClip } from './wordClipExtraction';
import { completeJob, failJob } from './audioJobs';
import { config } from '../config';

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
      data: { currentNarrationId: narration.id, currentAlignmentId: alignment.id, approvedTextReleaseId: null },
    });

    await completeJob(tx, job.id, { resultAssetId: asset.id, resultId: alignment.id });
  });
}

export async function runExtractClipsJob(prisma: PrismaClient, job: AudioJob) {
  const payload = job.requestPayload as unknown as ExtractClipsPayload;

  const narration = await prisma.textNarration.findUnique({ where: { id: payload.narrationId }, include: { asset: true } });
  if (!narration || narration.textId !== job.textId) {
    await failJob(prisma, job.id, { code: 'NARRATION_NOT_FOUND', message: 'Narration not found for this text', retryable: false });
    return;
  }

  const { readAudioAssetRange } = await import('./audioAssetStorage');
  const range = readAudioAssetRange(narration.asset.storageKey, 0, narration.asset.byteLength);
  if (!range) {
    await failJob(prisma, job.id, { code: 'NARRATION_ASSET_MISSING', message: 'Narration audio bytes are missing from storage', retryable: false });
    return;
  }
  const decoded = decodeWav(range.buffer);

  const allOccurrences = await prisma.wordOccurrence.findMany({
    where: { alignmentId: payload.alignmentId },
    orderBy: { ordinal: 'asc' },
  });
  const mapped = allOccurrences.filter(
    (o): o is typeof o & { speechStartSample: number; speechEndSample: number } =>
      o.speechStartSample !== null && o.speechEndSample !== null,
  );
  const boundaries = computeContiguousCutBoundaries(
    mapped.map((o) => ({ ordinal: o.ordinal, speechStartSample: o.speechStartSample, speechEndSample: o.speechEndSample })),
    decoded.frameCount,
  );

  if (boundaries.status !== 'OK') {
    await failJob(prisma, job.id, {
      code: 'CUT_REVIEW_REQUIRED',
      message: 'Word speech spans overlap or are non-increasing; manual boundary review is required before extraction.',
      retryable: false,
    });
    return;
  }

  const boundaryByOrdinal = new Map(boundaries.cuts.map((cut) => [cut.ordinal, cut]));
  const requestedOccurrences = allOccurrences.filter((o) => payload.occurrenceIds.includes(o.id));

  await prisma.$transaction(async (tx) => {
    for (const occurrence of requestedOccurrences) {
      const cut = boundaryByOrdinal.get(occurrence.ordinal);
      if (!cut) continue;

      const entry = await tx.textVocabularyEntry.findUnique({
        where: { alignmentId_occurrenceId: { alignmentId: payload.alignmentId, occurrenceId: occurrence.id } },
      });
      if (!entry || !entry.selected) {
        continue;
      }

      const clip = extractWordClip(decoded, cut.startSample, cut.endSample);
      const clipBytes = encodeWav(clip);
      const written = await writeAudioAsset({ textId: job.textId, kind: 'WORD_CLIP', bytes: clipBytes });

      const asset = await tx.audioAsset.create({
        data: {
          textId: job.textId,
          kind: 'WORD_CLIP',
          storageKey: written.storageKey,
          mimeType: 'audio/wav',
          byteLength: written.byteLength,
          sha256: written.sha256,
          sampleRate: clip.sampleRate,
          channels: clip.channels,
          bitDepth: clip.bitsPerSample,
          frameCount: clip.frameCount,
          state: 'READY',
        },
      });

      await tx.wordOccurrence.update({
        where: { id: occurrence.id },
        data: { cutStartSample: cut.startSample, cutEndSample: cut.endSample },
      });

      await tx.wordClip.upsert({
        where: { occurrenceId_extractionVersion: { occurrenceId: occurrence.id, extractionVersion: 1 } },
        update: {
          assetId: asset.id,
          startSample: cut.startSample,
          endSample: cut.endSample,
          narrationId: narration.id,
        },
        create: {
          textId: job.textId,
          narrationId: narration.id,
          alignmentId: payload.alignmentId,
          occurrenceId: occurrence.id,
          entryId: entry.id,
          assetId: asset.id,
          startSample: cut.startSample,
          endSample: cut.endSample,
          extractionVersion: 1,
        },
      });
    }

    await completeJob(tx, job.id, {});
  });
}
