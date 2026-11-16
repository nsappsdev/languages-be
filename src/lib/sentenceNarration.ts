import { AudioJob, Prisma, PrismaClient } from '@prisma/client';
import { config } from '../config';
import { computeRequestHash } from './audioJobs';
import { readAudioAssetRange, writeAudioAsset } from './audioAssetStorage';
import { ELEVEN_LABS_MODEL, ELEVEN_LABS_OUTPUT_FORMAT, generateNarration, ProviderError } from './elevenLabsNarration';
import { decodeWav, DecodedWav, encodeWav } from './pcmWav';
import { validReaderAsset } from './readerRelease';
import { splitSentences, SentenceSpan } from './sentenceSegmentation';
import { buildTextAlignment, ElevenLabsCharacterAlignment, TextAlignmentResult } from './textOccurrenceAlignment';
import { mapSourceText } from './textMap';

export interface SentenceRecording extends SentenceSpan {
  requiresRegeneration?: boolean;
  assetId: string | null;
  startSample: number;
  endSample: number;
  alignmentIssue?: string;
}

interface RecordedSentence {
  assetId: string;
  audio: DecodedWav;
  alignment: ElevenLabsCharacterAlignment | null;
}

function sentenceRequest(spans: SentenceSpan[], index: number, voiceId: string) {
  return { text: spans[index].text, voiceId, previousText: spans[index - 1]?.text, nextText: spans[index + 1]?.text };
}

function sentenceRequestHash(request: { text: string; voiceId: string; previousText?: string; nextText?: string }) {
  return computeRequestHash({ ...request, model: ELEVEN_LABS_MODEL, format: ELEVEN_LABS_OUTPUT_FORMAT, settingsVersion: 1 });
}

async function savedSentence(prisma: PrismaClient, textId: string, requestHash: string): Promise<RecordedSentence | null> {
  const saved = await prisma.sentenceAudio.findUnique({ where: { textId_requestHash: { textId, requestHash } }, include: { asset: true } });
  if (saved?.status !== 'SUCCEEDED' || !validReaderAsset(saved.asset)) return null;
  const stored = readAudioAssetRange(saved.asset.storageKey, 0, saved.asset.byteLength)!;
  return { assetId: saved.asset.id, audio: decodeWav(stored.buffer), alignment: saved.rawAlignment as unknown as ElevenLabsCharacterAlignment | null };
}

/** A virtual timeline describes independent files; no full-lesson audio is created. */
export function mapSentenceRecordings(text: string, spans: SentenceSpan[], parts: Array<RecordedSentence | null>) {
  const mapping: TextAlignmentResult = mapSourceText(text, spans);
  const sentences: SentenceRecording[] = [];
  let frameCount = 0;
  const sampleRate = 24000;
  for (const [index, span] of spans.entries()) {
    const part = parts[index];
    const startSample = frameCount;
    let issue: string | undefined;
    if (part) {
      if (part.audio.sampleRate !== sampleRate) throw new Error('Sentence audio must use the reader sample rate.');
      const local = buildTextAlignment({ text: span.text, alignment: part.alignment, sampleRate, algorithmVersion: 1 });
      // Decimal provider timestamps may round one sample past the decoded WAV.
      // Clamp only that quantization difference; larger overruns still need review.
      for (const word of local.occurrences) {
        if (word.speechEndSample === part.audio.frameCount + 1) word.speechEndSample = part.audio.frameCount;
      }
      const valid = local.status === 'OK' && local.occurrences.every(word => word.speechStartSample! >= 0 &&
        word.speechEndSample! > word.speechStartSample! && word.speechEndSample! <= part.audio.frameCount);
      if (valid) {
        const byStart = new Map(local.occurrences.map(word => [word.charStart + span.charStart, word]));
        for (const word of mapping.occurrences.filter(word => word.sentenceIndex === index)) {
          const timed = byStart.get(word.charStart)!;
          word.speechStartSample = timed.speechStartSample! + startSample;
          word.speechEndSample = timed.speechEndSample! + startSample;
          word.mappingStatus = 'MAPPED';
        }
      } else {
        issue = local.diagnostics.map(d => d.message).join(' ') || 'Word timing falls outside this sentence recording.';
        mapping.diagnostics.push({ code: local.diagnostics[0]?.code ?? 'NON_MONOTONIC_TIMING', message: `Sentence ${index + 1}: ${issue}` });
      }
      frameCount += part.audio.frameCount;
    }
    sentences.push({ ...span, assetId: part?.assetId ?? null, startSample, endSample: frameCount, ...(issue ? { alignmentIssue: issue } : {}) });
  }
  mapping.status = mapping.occurrences.length > 0 && parts.every(Boolean) && mapping.occurrences.every(word => word.mappingStatus === 'MAPPED') ? 'OK' : 'NEEDS_REVIEW';
  return { sentences, mapping, sampleRate, frameCount };
}

export async function sentenceAudioState(prisma: PrismaClient, textId: string, text: string, language: string, voiceId: string, ends?: number[]) {
  const spans = splitSentences(text, language, ends);
  const hashes = spans.map((_, index) => sentenceRequestHash(sentenceRequest(spans, index, voiceId)));
  const parts = await Promise.all(hashes.map(hash => savedSentence(prisma, textId, hash)));
  const state = mapSentenceRecordings(text, spans, parts);
  const failed = await prisma.sentenceAudio.findMany({ where: { textId, requestHash: { in: hashes }, status: 'FAILED', retryable: false } });
  state.sentences.forEach((sentence, index) => {
    if (failed.some(item => item.requestHash === hashes[index])) sentence.requiresRegeneration = true;
  });
  return state;
}

export async function generateSentenceAssets(prisma: PrismaClient, job: AudioJob, text: string, language: string, payload: {
  voiceId: string; sentenceEndOffsets?: number[]; sentenceIndex?: number; regenerateSentenceIndex?: number;
}) {
  const spans = splitSentences(text, language, payload.sentenceEndOffsets);
  const target = payload.sentenceIndex ?? payload.regenerateSentenceIndex;
  for (const [index] of spans.entries()) {
    if (target !== undefined && target !== index) continue;
    const active = await prisma.audioJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { leaseUntil: new Date(Date.now() + 5 * 60 * 1000) } });
    if (!active.count) throw new Error('Sentence generation job is no longer active.');
    try { await recordSentence(prisma, job, sentenceRequest(spans, index, payload.voiceId), payload.regenerateSentenceIndex === index); }
    catch (error) { if (error instanceof Error) error.message = `Sentence ${index + 1}. ${error.message}`; throw error; }
  }
  return sentenceAudioState(prisma, job.textId, text, language, payload.voiceId, payload.sentenceEndOffsets);
}

/** Store each result before dispatching the next request, including uncertain failures. */
async function recordSentence(prisma: PrismaClient, job: AudioJob, request: {
  text: string; voiceId: string; previousText?: string; nextText?: string;
}, regenerate: boolean): Promise<RecordedSentence> {
  // Bump this version if synthesis settings change, so incompatible audio is never reused.
  const requestHash = sentenceRequestHash(request);
  const key = { textId: job.textId, requestHash };
  const previous = await prisma.sentenceAudio.findUnique({ where: { textId_requestHash: key }, include: { asset: true } });
  const forceNew = regenerate && previous?.ownerJobId !== job.id;
  if (previous?.status === 'SUCCEEDED' && !forceNew) {
    if (!validReaderAsset(previous.asset)) throw new Error('Saved sentence audio is unavailable. Regenerate this sentence.');
    const stored = readAudioAssetRange(previous.asset.storageKey, 0, previous.asset.byteLength)!;
    return { assetId: previous.asset.id, audio: decodeWav(stored.buffer),
      alignment: previous.rawAlignment as unknown as ElevenLabsCharacterAlignment | null };
  }
  if (previous && !forceNew && !(previous.status === 'FAILED' && previous.retryable)) {
    throw new Error('A sentence request has an uncertain outcome. Review the provider history before explicitly regenerating that sentence.');
  }
  await prisma.sentenceAudio.upsert({ where: { textId_requestHash: key },
    create: { ...key, ownerJobId: job.id },
    update: { ownerJobId: job.id, status: 'RUNNING', retryable: false } });
  try {
    const result = await generateNarration(request, { apiKey: config.elevenLabs.apiKey });
    if (!result.audio.frameCount) throw new Error('The provider returned an empty sentence recording.');
    const stored = await writeAudioAsset({ textId: job.textId, kind: 'SENTENCE', bytes: encodeWav(result.audio) });
    const asset = await prisma.$transaction(async tx => {
      const created = await tx.audioAsset.create({ data: {
        ...stored, textId: job.textId, kind: 'SENTENCE', mimeType: 'audio/wav', state: 'READY',
        sampleRate: result.audio.sampleRate, channels: result.audio.channels,
        bitDepth: result.audio.bitsPerSample, frameCount: result.audio.frameCount,
      } });
      const updated = await tx.sentenceAudio.updateMany({ where: { ...key, ownerJobId: job.id, status: 'RUNNING' },
        data: { status: 'SUCCEEDED', assetId: created.id, rawAlignment: result.alignment ? result.alignment as unknown as Prisma.InputJsonValue : Prisma.JsonNull } });
      if (updated.count !== 1) throw new Error('Sentence generation was interrupted. Reload before continuing.');
      return created;
    });
    return { assetId: asset.id, audio: result.audio, alignment: result.alignment };
  } catch (error) {
    await prisma.sentenceAudio.updateMany({ where: { ...key, ownerJobId: job.id, status: 'RUNNING' },
      data: { status: 'FAILED', retryable: error instanceof ProviderError && error.retryable && !error.possibleCharge } });
    throw error;
  }
}

/** Rebase real provider timings onto the assembled PCM timeline. */
export function assembleSentences(text: string, spans: SentenceSpan[], recordings: RecordedSentence[]) {
  const sampleRate = recordings[0].audio.sampleRate;
  const frameCount = recordings.reduce((total, part) => total + part.audio.frameCount, 0);
  const samples = new Int16Array(frameCount);
  const alignment: ElevenLabsCharacterAlignment = { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] };
  const sentences: SentenceRecording[] = [];
  let offset = 0;
  let charCursor = 0;
  let validAlignment = true;
  for (const [index, span] of spans.entries()) {
    const part = recordings[index];
    const local = part.alignment;
    const mapped = buildTextAlignment({ text: span.text, alignment: local, sampleRate, algorithmVersion: 1 });
    if (mapped.status !== 'OK' || mapped.occurrences.some(word =>
      word.speechStartSample! < 0 || word.speechEndSample! > part.audio.frameCount)) validAlignment = false;
    const gap = text.slice(charCursor, span.charStart);
    for (const character of Array.from(gap)) {
      alignment.characters.push(character);
      alignment.character_start_times_seconds.push(offset / sampleRate);
      alignment.character_end_times_seconds.push(offset / sampleRate);
    }
    if (local) {
      alignment.characters.push(...local.characters);
      alignment.character_start_times_seconds.push(...local.character_start_times_seconds.map(time => time + offset / sampleRate));
      alignment.character_end_times_seconds.push(...local.character_end_times_seconds.map(time => time + offset / sampleRate));
    }
    samples.set(part.audio.samples, offset);
    sentences.push({ ...span, assetId: part.assetId, startSample: offset, endSample: offset + part.audio.frameCount });
    offset += part.audio.frameCount;
    charCursor = span.charEnd;
  }
  for (const character of Array.from(text.slice(charCursor))) {
    alignment.characters.push(character);
    alignment.character_start_times_seconds.push(offset / sampleRate);
    alignment.character_end_times_seconds.push(offset / sampleRate);
  }
  return { audio: { ...recordings[0].audio, samples, frameCount }, alignment: validAlignment ? alignment : null, sentences };
}
