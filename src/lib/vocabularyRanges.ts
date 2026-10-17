import { WordOccurrence } from '@prisma/client';
import { ReaderReleaseError } from './readerRelease';

export interface VocabularyRange { occurrenceId: string; endOccurrenceId?: string | null }

/** Resolve against original, immutable alignment words, never spelling or estimated timing. */
export function resolveVocabularyRange(words: WordOccurrence[], range: VocabularyRange) {
  const start = words.findIndex(word => word.id === range.occurrenceId);
  const end = range.endOccurrenceId ? words.findIndex(word => word.id === range.endOccurrenceId) : start;
  if (start < 0 || end < start) throw new ReaderReleaseError(422, 'Choose a valid word or forward phrase range.');
  const members = words.slice(start, end + 1);
  if (members.some(word => word.sentenceId !== members[0].sentenceId || word.mappingStatus !== 'MAPPED' ||
      word.speechStartSample === null || word.speechEndSample === null))
    throw new ReaderReleaseError(422, 'A phrase must contain consecutive aligned words in one sentence.');
  return { first: members[0], last: members[members.length - 1], members };
}

export function assertNonOverlappingRanges(words: WordOccurrence[], ranges: VocabularyRange[]) {
  const covered = new Set<string>();
  for (const range of ranges) {
    for (const word of resolveVocabularyRange(words, range).members) {
      if (covered.has(word.id)) throw new ReaderReleaseError(409, 'Learning words and phrases overlap. Remove the existing selection first.');
      covered.add(word.id);
    }
  }
}
