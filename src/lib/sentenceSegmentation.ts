export interface SentenceSpan {
  text: string;
  charStart: number;
  charEnd: number;
}

/** Offsets always refer to the saved source, including its original whitespace. */
export function splitSentences(text: string, language = 'en', endOffsets?: number[]): SentenceSpan[] {
  let ends = endOffsets;
  if (!ends) {
    const Segmenter = (Intl as unknown as {
      Segmenter: new (locale: string, options: { granularity: 'sentence' }) => {
        segment(value: string): Iterable<{ index: number; segment: string }>;
      };
    }).Segmenter;
    const segments = [...new Segmenter(language, { granularity: 'sentence' }).segment(text)];
    ends = segments.filter((part, index) => /[\p{L}\p{N}]/u.test(part.segment) && (index === segments.length - 1 ||
      !/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)\.$/i.test(part.segment.trimEnd())))
      .map(part => part.index + part.segment.length);
    if (ends.length) ends[ends.length - 1] = text.length;
  }
  if (!ends.length || ends.length > 500 || ends[ends.length - 1] !== text.length) {
    throw new Error('Sentence boundaries must cover the complete saved text.');
  }
  let cursor = 0;
  return ends.map(end => {
    if (!Number.isInteger(end) || end <= cursor || end > text.length ||
        (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) ||
        (end < text.length && /[\p{L}\p{N}]/u.test(text[end - 1]) && /[\p{L}\p{N}]/u.test(text[end]))) {
      throw new Error('Place sentence breaks between words, in source order.');
    }
    const raw = text.slice(cursor, end);
    const charStart = cursor + raw.length - raw.trimStart().length;
    cursor = end;
    const value = raw.trim();
    if (!/[\p{L}\p{N}]/u.test(value)) throw new Error('Each sentence must contain a word.');
    return { text: value, charStart, charEnd: charStart + value.length };
  });
}
