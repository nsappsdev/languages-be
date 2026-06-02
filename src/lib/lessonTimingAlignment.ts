import { canonicalizeVocabularyText } from './vocabularyIngestion';

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface LessonTimingSegment {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface LessonWordTiming {
  id: string;
  text: string;
  normalizedText: string;
  startMs: number;
  endMs: number;
  order: number;
}

export interface LessonSentenceTiming {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  wordMarkIds: string[];
  order: number;
}

export interface LessonChunkTiming {
  id: string;
  text: string;
  normalizedText: string;
  startMs: number;
  endMs: number;
  wordMarkIds: string[];
  order: number;
}

export interface GeneratedLessonTimings {
  segments: LessonTimingSegment[];
  wordTimings: LessonWordTiming[];
  sentenceTimings: LessonSentenceTiming[];
  chunkTimings: LessonChunkTiming[];
  warnings: string[];
  transcriptText: string;
}

export interface SuggestedTimingChunk {
  text: string;
  wordMarkIds: string[];
}

interface TextWord {
  text: string;
  normalizedText: string;
  startIndex: number;
  endIndex: number;
}

interface TextSentence {
  text: string;
  startIndex: number;
  endIndex: number;
}

const WORD_PATTERN = /[A-Za-z]+(?:['’][A-Za-z]+)?/g;
const SENTENCE_PATTERN = /[^.!?]+[.!?]+|[^.!?]+$/g;
const DEFAULT_ESTIMATED_WORD_MS = 240;

export function generateLessonTimingsFromTranscript({
  lessonText,
  transcriptText,
  transcriptWords,
}: {
  lessonText: string;
  transcriptText: string;
  transcriptWords: TranscriptWord[];
}): GeneratedLessonTimings {
  const lessonWords = extractTextWords(lessonText);
  const sentences = extractTextSentences(lessonText);
  const transcriptWordsWithText = transcriptWords
    .map((word) => ({
      ...word,
      normalizedText: canonicalizeVocabularyText(word.word),
    }))
    .filter((word) => word.normalizedText.length > 0 && word.end > word.start);

  const warnings: string[] = [];
  if (!lessonWords.length) {
    warnings.push('Lesson text does not contain any English words to align.');
  }
  if (!transcriptWordsWithText.length) {
    warnings.push('Transcript did not return usable word timestamps.');
  }

  const alignment = alignWords(
    lessonWords.map((word) => word.normalizedText),
    transcriptWordsWithText.map((word) => word.normalizedText),
  );
  const transcriptIndexByLessonIndex = new Map(alignment);

  const wordTimings = lessonWords.flatMap((word, lessonWordIndex): LessonWordTiming[] => {
    const transcriptWordIndex = transcriptIndexByLessonIndex.get(lessonWordIndex);
    const estimatedRange =
      transcriptWordIndex === undefined
        ? estimateMissingWordRange({
            lessonWordIndex,
            lessonWords,
            transcriptIndexByLessonIndex,
            transcriptWords: transcriptWordsWithText,
          })
        : null;

    const startMs =
      transcriptWordIndex === undefined
        ? estimatedRange?.startMs
        : secondsToMilliseconds(transcriptWordsWithText[transcriptWordIndex].start);
    const endMs =
      transcriptWordIndex === undefined
        ? estimatedRange?.endMs
        : secondsToMilliseconds(transcriptWordsWithText[transcriptWordIndex].end);

    if (startMs === undefined || endMs === undefined) {
      warnings.push(`No audio timestamp found for "${word.text}".`);
      return [];
    }
    if (estimatedRange) {
      warnings.push(`Estimated audio timestamp for "${word.text}" from neighboring words.`);
    }

    return [
      {
        id: `word-${lessonWordIndex + 1}`,
        text: word.text,
        normalizedText: word.normalizedText,
        startMs,
        endMs: Math.max(startMs + 1, endMs),
        order: lessonWordIndex,
      },
    ];
  });

  const wordTimingByOrder = new Map(wordTimings.map((mark) => [mark.order, mark]));
  const sentenceTimings = sentences.flatMap((sentence, sentenceIndex): LessonSentenceTiming[] => {
    const sentenceWordMarks = lessonWords
      .map((word, wordIndex) => ({ word, mark: wordTimingByOrder.get(wordIndex) }))
      .filter(
        (entry): entry is { word: TextWord; mark: LessonWordTiming } =>
          entry.mark !== undefined &&
          entry.word.startIndex >= sentence.startIndex &&
          entry.word.endIndex <= sentence.endIndex,
      );

    if (!sentenceWordMarks.length) {
      warnings.push(`No complete audio timestamp found for sentence "${sentence.text}".`);
      return [];
    }

    const firstMark = sentenceWordMarks[0].mark;
    const lastMark = sentenceWordMarks[sentenceWordMarks.length - 1].mark;
    return [
      {
        id: `sentence-${sentenceIndex + 1}`,
        text: sentence.text,
        startMs: firstMark.startMs,
        endMs: lastMark.endMs,
        wordMarkIds: sentenceWordMarks.map((entry) => entry.mark.id),
        order: sentenceIndex,
      },
    ];
  });

  const segments = sentenceTimings.map((sentence): LessonTimingSegment => ({
    id: sentence.id,
    text: sentence.text,
    startMs: sentence.startMs,
    endMs: sentence.endMs,
  }));
  const chunkTimings = buildLogicalChunkTimings({
    suggestedChunks: sentenceTimings.map((sentence) => ({
      text: sentence.text,
      wordMarkIds: sentence.wordMarkIds,
    })),
    wordTimings,
  });

  if (!segments.length && lessonText.trim().length > 0) {
    warnings.push('No sentence timing ranges could be generated.');
  }

  return {
    segments,
    wordTimings,
    sentenceTimings,
    chunkTimings,
    warnings: dedupeWarnings(warnings),
    transcriptText,
  };
}

export function buildLogicalChunkTimings({
  suggestedChunks,
  wordTimings,
}: {
  suggestedChunks: SuggestedTimingChunk[];
  wordTimings: LessonWordTiming[];
}): LessonChunkTiming[] {
  const wordTimingById = new Map(wordTimings.map((mark) => [mark.id, mark]));
  const seenWordIds = new Set<string>();
  const chunks: LessonChunkTiming[] = [];

  for (const suggested of suggestedChunks) {
    const wordMarkIds = suggested.wordMarkIds.filter((id) => wordTimingById.has(id));
    if (!wordMarkIds.length || wordMarkIds.some((id) => seenWordIds.has(id))) {
      continue;
    }

    const marks = wordMarkIds
      .map((id) => wordTimingById.get(id))
      .filter((mark): mark is LessonWordTiming => Boolean(mark))
      .sort((left, right) => left.order - right.order);
    if (!marks.length || !areContiguousWordMarks(marks)) {
      continue;
    }

    const text = suggested.text.trim() || marks.map((mark) => mark.text).join(' ');
    const normalizedText = canonicalizeVocabularyText(text);
    if (!normalizedText) {
      continue;
    }

    for (const id of wordMarkIds) {
      seenWordIds.add(id);
    }
    chunks.push({
      id: `chunk-${chunks.length + 1}`,
      text,
      normalizedText,
      startMs: marks[0].startMs,
      endMs: marks[marks.length - 1].endMs,
      wordMarkIds: marks.map((mark) => mark.id),
      order: chunks.length,
    });
  }

  return chunks;
}

export function buildHeuristicLogicalChunkTimings(
  wordTimings: LessonWordTiming[],
): LessonChunkTiming[] {
  const suggestedChunks: SuggestedTimingChunk[] = [];
  let index = 0;

  while (index < wordTimings.length) {
    const current = wordTimings[index];
    const next = wordTimings[index + 1];
    const afterNext = wordTimings[index + 2];

    if (isCapitalized(current.text) && next && isCapitalized(next.text)) {
      suggestedChunks.push({
        text: [current.text, next.text].join(' '),
        wordMarkIds: [current.id, next.id],
      });
      index += 2;
      continue;
    }

    if (isPreposition(current.normalizedText) && next) {
      const marks = [current];
      if (isArticleOrDeterminer(next.normalizedText) && afterNext) {
        marks.push(next, afterNext);
      } else {
        marks.push(next);
      }
      suggestedChunks.push({
        text: marks.map((mark) => mark.text).join(' '),
        wordMarkIds: marks.map((mark) => mark.id),
      });
      index += marks.length;
      continue;
    }

    if (isArticleOrDeterminer(current.normalizedText) && next) {
      suggestedChunks.push({
        text: [current.text, next.text].join(' '),
        wordMarkIds: [current.id, next.id],
      });
      index += 2;
      continue;
    }

    suggestedChunks.push({
      text: current.text,
      wordMarkIds: [current.id],
    });
    index += 1;
  }

  return buildLogicalChunkTimings({ suggestedChunks, wordTimings });
}

function extractTextWords(text: string): TextWord[] {
  const result: TextWord[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    const matchedText = match[0];
    const normalizedText = canonicalizeVocabularyText(matchedText);
    if (!normalizedText) continue;
    const startIndex = match.index ?? 0;
    result.push({
      text: matchedText,
      normalizedText,
      startIndex,
      endIndex: startIndex + matchedText.length,
    });
  }
  return result;
}

function areContiguousWordMarks(marks: LessonWordTiming[]) {
  for (let index = 1; index < marks.length; index += 1) {
    if (marks[index].order !== marks[index - 1].order + 1) {
      return false;
    }
  }
  return true;
}

function isPreposition(value: string) {
  return new Set([
    'about',
    'above',
    'after',
    'against',
    'around',
    'at',
    'before',
    'behind',
    'between',
    'by',
    'during',
    'for',
    'from',
    'in',
    'inside',
    'into',
    'near',
    'of',
    'on',
    'onto',
    'over',
    'through',
    'to',
    'under',
    'with',
    'without',
  ]).has(value);
}

function isArticleOrDeterminer(value: string) {
  return new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'our', 'their']).has(value);
}

function isCapitalized(value: string) {
  return /^[A-Z][A-Za-z'’]*$/.test(value);
}

function extractTextSentences(text: string): TextSentence[] {
  const result: TextSentence[] = [];
  for (const match of text.matchAll(SENTENCE_PATTERN)) {
    const rawText = match[0];
    const leadingWhitespace = rawText.match(/^\s*/)?.[0].length ?? 0;
    const trimmedText = rawText.trim();
    if (!trimmedText) continue;
    const startIndex = (match.index ?? 0) + leadingWhitespace;
    result.push({
      text: trimmedText,
      startIndex,
      endIndex: startIndex + trimmedText.length,
    });
  }
  return result;
}

function alignWords(lessonWords: string[], transcriptWords: string[]) {
  const rowCount = lessonWords.length + 1;
  const columnCount = transcriptWords.length + 1;
  const scores = Array.from({ length: rowCount }, () => Array<number>(columnCount).fill(0));

  for (let lessonIndex = lessonWords.length - 1; lessonIndex >= 0; lessonIndex -= 1) {
    for (
      let transcriptIndex = transcriptWords.length - 1;
      transcriptIndex >= 0;
      transcriptIndex -= 1
    ) {
      const matchScore =
        lessonWords[lessonIndex] === transcriptWords[transcriptIndex]
          ? scores[lessonIndex + 1][transcriptIndex + 1] + 1
          : 0;
      scores[lessonIndex][transcriptIndex] = Math.max(
        matchScore,
        scores[lessonIndex + 1][transcriptIndex],
        scores[lessonIndex][transcriptIndex + 1],
      );
    }
  }

  const result: Array<[number, number]> = [];
  let lessonIndex = 0;
  let transcriptIndex = 0;
  while (lessonIndex < lessonWords.length && transcriptIndex < transcriptWords.length) {
    if (
      lessonWords[lessonIndex] === transcriptWords[transcriptIndex] &&
      scores[lessonIndex][transcriptIndex] === scores[lessonIndex + 1][transcriptIndex + 1] + 1
    ) {
      result.push([lessonIndex, transcriptIndex]);
      lessonIndex += 1;
      transcriptIndex += 1;
      continue;
    }

    if (scores[lessonIndex + 1][transcriptIndex] >= scores[lessonIndex][transcriptIndex + 1]) {
      lessonIndex += 1;
    } else {
      transcriptIndex += 1;
    }
  }

  return result;
}

function estimateMissingWordRange({
  lessonWordIndex,
  lessonWords,
  transcriptIndexByLessonIndex,
  transcriptWords,
}: {
  lessonWordIndex: number;
  lessonWords: TextWord[];
  transcriptIndexByLessonIndex: Map<number, number>;
  transcriptWords: Array<TranscriptWord & { normalizedText: string }>;
}) {
  let previousLessonIndex = lessonWordIndex - 1;
  while (previousLessonIndex >= 0 && !transcriptIndexByLessonIndex.has(previousLessonIndex)) {
    previousLessonIndex -= 1;
  }

  let nextLessonIndex = lessonWordIndex + 1;
  while (
    nextLessonIndex < lessonWords.length &&
    !transcriptIndexByLessonIndex.has(nextLessonIndex)
  ) {
    nextLessonIndex += 1;
  }

  const previousTranscriptIndex =
    previousLessonIndex >= 0 ? transcriptIndexByLessonIndex.get(previousLessonIndex) : undefined;
  const nextTranscriptIndex =
    nextLessonIndex < lessonWords.length ? transcriptIndexByLessonIndex.get(nextLessonIndex) : undefined;

  if (previousTranscriptIndex !== undefined && nextTranscriptIndex !== undefined) {
    return estimateWithinGap({
      firstMissingLessonIndex: previousLessonIndex + 1,
      lastMissingLessonIndex: nextLessonIndex - 1,
      targetLessonIndex: lessonWordIndex,
      lessonWords,
      startMs: secondsToMilliseconds(transcriptWords[previousTranscriptIndex].end),
      endMs: secondsToMilliseconds(transcriptWords[nextTranscriptIndex].start),
    });
  }

  if (previousTranscriptIndex !== undefined) {
    const startMs = secondsToMilliseconds(transcriptWords[previousTranscriptIndex].end);
    const offset = countMissingWords({
      firstMissingLessonIndex: previousLessonIndex + 1,
      targetLessonIndex: lessonWordIndex,
      lessonWords,
    });
    return {
      startMs: startMs + offset * DEFAULT_ESTIMATED_WORD_MS,
      endMs: startMs + (offset + 1) * DEFAULT_ESTIMATED_WORD_MS,
    };
  }

  if (nextTranscriptIndex !== undefined) {
    const nextStartMs = secondsToMilliseconds(transcriptWords[nextTranscriptIndex].start);
    const missingCount = nextLessonIndex;
    const targetOffset = lessonWordIndex;
    const blockDurationMs = missingCount * DEFAULT_ESTIMATED_WORD_MS;
    const startMs = Math.max(0, nextStartMs - blockDurationMs + targetOffset * DEFAULT_ESTIMATED_WORD_MS);
    return {
      startMs,
      endMs: Math.min(nextStartMs, startMs + DEFAULT_ESTIMATED_WORD_MS),
    };
  }

  return null;
}

function estimateWithinGap({
  firstMissingLessonIndex,
  lastMissingLessonIndex,
  targetLessonIndex,
  lessonWords,
  startMs,
  endMs,
}: {
  firstMissingLessonIndex: number;
  lastMissingLessonIndex: number;
  targetLessonIndex: number;
  lessonWords: TextWord[];
  startMs: number;
  endMs: number;
}) {
  const missingWords = lessonWords.slice(firstMissingLessonIndex, lastMissingLessonIndex + 1);
  if (!missingWords.length) return null;

  const safeStartMs = Math.min(startMs, endMs);
  const safeEndMs = Math.max(startMs, endMs);
  const gapDurationMs = safeEndMs - safeStartMs;
  if (gapDurationMs <= 0) {
    return {
      startMs: safeStartMs,
      endMs: safeStartMs + 1,
    };
  }

  const weights = missingWords.map((word) => Math.max(1, word.normalizedText.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const targetOffset = targetLessonIndex - firstMissingLessonIndex;
  const startWeight = weights.slice(0, targetOffset).reduce((sum, weight) => sum + weight, 0);
  const endWeight = startWeight + weights[targetOffset];

  return {
    startMs: safeStartMs + Math.round((gapDurationMs * startWeight) / totalWeight),
    endMs: safeStartMs + Math.round((gapDurationMs * endWeight) / totalWeight),
  };
}

function countMissingWords({
  firstMissingLessonIndex,
  targetLessonIndex,
  lessonWords,
}: {
  firstMissingLessonIndex: number;
  targetLessonIndex: number;
  lessonWords: TextWord[];
}) {
  return lessonWords.slice(firstMissingLessonIndex, targetLessonIndex).filter(Boolean).length;
}

function secondsToMilliseconds(value: number) {
  return Math.max(0, Math.round(value * 1000));
}

function dedupeWarnings(warnings: string[]) {
  return [...new Set(warnings)];
}
