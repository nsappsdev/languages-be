import { secondsToSampleIndex } from './pcmWav';
import type { SentenceSpan } from './sentenceSegmentation';

/**
 * Our deterministic mapping from ElevenLabs character-level alignment to
 * word occurrences and sentence groups. This is our algorithm, not a
 * documented provider cookbook method (see plan §3/§6.1).
 */

export interface ElevenLabsCharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export type AlignmentDiagnosticCode =
  | 'ALIGNMENT_MISSING'
  | 'ALIGNMENT_INVALID'
  | 'ALIGNMENT_ARRAY_LENGTH_MISMATCH'
  | 'NON_FINITE_TIMING'
  | 'NON_MONOTONIC_TIMING'
  | 'INVALID_WORD_TIMING'
  | 'TEXT_ALIGNMENT_MISMATCH';

export interface AlignmentDiagnostic {
  code: AlignmentDiagnosticCode;
  message: string;
}

export type OccurrenceMappingStatus = 'MAPPED' | 'UNMAPPED';

export interface WordOccurrenceResult {
  ordinal: number;
  sentenceIndex: number;
  charStart: number;
  charEnd: number;
  surfaceText: string;
  normalizedText: string;
  speechStartSample: number | null;
  speechEndSample: number | null;
  mappingStatus: OccurrenceMappingStatus;
}

export interface SentenceResult {
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
  occurrenceIds: number[];
}

export interface TextAlignmentResult {
  status: 'OK' | 'NEEDS_REVIEW';
  diagnostics: AlignmentDiagnostic[];
  occurrences: WordOccurrenceResult[];
  sentences: SentenceResult[];
}

export interface BuildTextAlignmentInput {
  text: string;
  alignment: unknown;
  algorithmVersion: number;
  sampleRate?: number;
  sentenceSpans?: SentenceSpan[];
  frameCount?: number;
}

// v1 English word tokenization policy: letters/digits with internal straight
// or curly apostrophes preserved; hyphens split into separate tokens.
const WORD_TOKEN_REGEX = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

function normalizeToken(surface: string): string {
  return surface.replace(/['’]/g, '').toLowerCase();
}

function segmentSentences(text: string): Array<{ charStart: number; charEnd: number; text: string }> {
  const sentences: Array<{ charStart: number; charEnd: number; text: string }> = [];
  const regex = /[^.!?]+[.!?]+/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  while ((match = regex.exec(text))) {
    const raw = match[0];
    const start = match.index;
    const leadingTrim = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed.length) {
      sentences.push({ charStart: start + leadingTrim, charEnd: start + leadingTrim + trimmed.length, text: trimmed });
    }
    lastIndex = start + raw.length;
  }
  if (lastIndex < text.length) {
    const raw = text.slice(lastIndex);
    const trimmed = raw.trim();
    if (trimmed.length) {
      const leadingTrim = raw.length - raw.trimStart().length;
      sentences.push({
        charStart: lastIndex + leadingTrim,
        charEnd: lastIndex + leadingTrim + trimmed.length,
        text: trimmed,
      });
    }
  }
  return sentences;
}

export function buildTextAlignment(input: BuildTextAlignmentInput): TextAlignmentResult {
  const { text, alignment, sampleRate = 24000 } = input;
  const diagnostics: AlignmentDiagnostic[] = [];

  if (!alignment) {
    return {
      status: 'NEEDS_REVIEW',
      diagnostics: [{ code: 'ALIGNMENT_MISSING', message: 'Provider returned no alignment for this narration.' }],
      occurrences: [],
      sentences: [],
    };
  }

  const candidate = alignment as Partial<ElevenLabsCharacterAlignment>;
  if (!Array.isArray(candidate.characters) || !candidate.characters.every(c => typeof c === 'string' && c.length > 0) ||
      !Array.isArray(candidate.character_start_times_seconds) || !Array.isArray(candidate.character_end_times_seconds)) {
    return { status: 'NEEDS_REVIEW', diagnostics: [{ code: 'ALIGNMENT_INVALID', message: 'The recording is saved, but its timing data is malformed. Repair timings using this recording.' }], occurrences: [], sentences: [] };
  }
  const characters = candidate.characters;
  const starts = [...candidate.character_start_times_seconds];
  const ends = [...candidate.character_end_times_seconds];
  if (characters.length !== starts.length || characters.length !== ends.length) {
    return {
      status: 'NEEDS_REVIEW',
      diagnostics: [
        {
          code: 'ALIGNMENT_ARRAY_LENGTH_MISMATCH',
          message: `Alignment arrays disagree in length: characters=${characters.length}, starts=${starts.length}, ends=${ends.length}`,
        },
      ],
      occurrences: [],
      sentences: [],
    };
  }

  for (let i = 0; i < characters.length; i += 1) {
    if (!Number.isFinite(starts[i]) || !Number.isFinite(ends[i])) {
      diagnostics.push({
        code: 'NON_FINITE_TIMING',
        message: `Non-finite character timing at index ${i}`,
      });
      break;
    }
  }
  if (!diagnostics.length) {
    const tolerance = 0.0005;
    for (let i = 0; i < characters.length; i += 1) {
      // Only quantization-sized boundary corrections are safe without listening.
      if (starts[i] < 0 && starts[i] >= -tolerance) starts[i] = 0;
      if (ends[i] < 0 && ends[i] >= -tolerance) ends[i] = 0;
      if (i && starts[i] < ends[i - 1] && ends[i - 1] - starts[i] <= tolerance + Number.EPSILON)
        starts[i] = ends[i - 1];
      const startsBeforeEnds = starts[i] <= ends[i];
      const monotonicAcrossChars = i === 0 || starts[i] >= ends[i - 1];
      if (starts[i] < 0 || ends[i] < 0 || !startsBeforeEnds || !monotonicAcrossChars) {
        diagnostics.push({
          code: 'NON_MONOTONIC_TIMING',
          message: `Non-monotonic character timing at index ${i}`,
        });
        break;
      }
    }
  }
  if (diagnostics.length) {
    return { status: 'NEEDS_REVIEW', diagnostics, occurrences: [], sentences: [] };
  }

  const reconstructed = characters.join('');
  if (reconstructed !== text) {
    return {
      status: 'NEEDS_REVIEW',
      diagnostics: [
        {
          code: 'TEXT_ALIGNMENT_MISMATCH',
          message:
            'The recording is saved, but its timing text does not match the saved sentence. Repair timings using this recording.',
        },
      ],
      occurrences: [],
      sentences: [],
    };
  }

  const sentenceSpans = input.sentenceSpans ?? segmentSentences(text);
  // Provider entries may contain a Unicode code point or a multi-character token.
  const characterStarts = characters.flatMap((character, index) => Array(character.length).fill(starts[index]) as number[]);
  const characterEnds = characters.flatMap((character, index) => Array(character.length).fill(ends[index]) as number[]);
  const occurrences: WordOccurrenceResult[] = [];
  let ordinal = 0;
  for (const match of text.matchAll(WORD_TOKEN_REGEX)) {
    const surfaceText = match[0];
    const charStart = match.index ?? 0;
    const charEnd = charStart + surfaceText.length;
    const sentenceIndex = sentenceSpans.findIndex(
      (s) => charStart >= s.charStart && charEnd <= s.charEnd,
    );
    const speechStartSample = secondsToSampleIndex(characterStarts[charStart], sampleRate);
    let speechEndSample = secondsToSampleIndex(characterEnds[charEnd - 1], sampleRate);
    if (input.frameCount !== undefined && speechEndSample > input.frameCount &&
        speechEndSample - input.frameCount <= Math.floor(sampleRate / 2000)) speechEndSample = input.frameCount;
    if (!Number.isSafeInteger(speechStartSample) || !Number.isSafeInteger(speechEndSample) || speechEndSample <= speechStartSample ||
        (input.frameCount !== undefined && speechEndSample > input.frameCount)) {
      const seconds = (samples: number) => `${(samples / sampleRate).toFixed(6)} s`;
      diagnostics.push({ code: 'INVALID_WORD_TIMING', message: speechEndSample <= speechStartSample
        ? `Word "${surfaceText}" has no positive duration (start ${seconds(speechStartSample)}, end ${seconds(speechEndSample)}).`
        : `Word "${surfaceText}" ends at ${seconds(speechEndSample)}, after the recording ends at ${seconds(input.frameCount ?? 0)} (${speechEndSample - (input.frameCount ?? 0)} samples beyond the audio).` });
    }
    const previousWord = occurrences[occurrences.length - 1];
    if (previousWord && speechStartSample < previousWord.speechEndSample!)
      diagnostics.push({ code: 'NON_MONOTONIC_TIMING', message: `Word "${surfaceText}" overlaps the previous word. Repair timings using the saved recording.` });

    occurrences.push({
      ordinal,
      sentenceIndex,
      charStart,
      charEnd,
      surfaceText,
      normalizedText: normalizeToken(surfaceText),
      speechStartSample,
      speechEndSample,
      mappingStatus: sentenceIndex === -1 ? 'UNMAPPED' : 'MAPPED',
    });
    ordinal += 1;
  }

  const sentences: SentenceResult[] = sentenceSpans.map((span, index) => ({
    index,
    text: span.text,
    charStart: span.charStart,
    charEnd: span.charEnd,
    occurrenceIds: occurrences.filter((o) => o.sentenceIndex === index).map((o) => o.ordinal),
  }));

  return { status: diagnostics.length ? 'NEEDS_REVIEW' : 'OK', diagnostics, occurrences, sentences };
}
