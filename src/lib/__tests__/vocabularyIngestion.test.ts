import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildLessonVocabularyCoverage,
  canonicalizeVocabularyText,
  extractLessonVocabularyCandidates,
  type LessonVocabularyEntryWithTranslations,
} from '../vocabularyIngestion';

const createEntry = (
  id: string,
  englishText: string,
  kind: 'WORD' | 'PHRASE' = 'WORD',
): LessonVocabularyEntryWithTranslations => ({
  id,
  lessonId: 'lesson-1',
  sourceItemId: null,
  englishText,
  normalizedText: canonicalizeVocabularyText(englishText),
  focusText: null,
  focusNormalizedText: null,
  kind,
  order: 0,
  notes: null,
  tags: [],
  createdAt: new Date('2026-05-22T00:00:00.000Z'),
  updatedAt: new Date('2026-05-22T00:00:00.000Z'),
  translations: [
    {
      id: `translation-${id}`,
      entryId: id,
      languageCode: 'am',
      translation: 'թարգմանություն',
      usageExample: null,
      createdAt: new Date('2026-05-22T00:00:00.000Z'),
      updatedAt: new Date('2026-05-22T00:00:00.000Z'),
    },
  ],
});

describe('lesson vocabulary ingestion', () => {
  it('normalizes multi-word semantic units consistently', () => {
    assert.equal(canonicalizeVocabularyText('  In   the Fall! '), 'in the fall');
    assert.equal(canonicalizeVocabularyText("Mark's"), 'mark');
  });

  it('counts longest phrase matches without requiring separate word entries', () => {
    const coverage = buildLessonVocabularyCoverage(
      [
        createEntry('word-soap', 'soap'),
        createEntry('phrase-soap-operas', 'soap operas', 'PHRASE'),
      ],
      ['She likes soap operas, not soap.'],
    );

    const phrase = coverage.find((item) => item.entryId === 'phrase-soap-operas');
    const word = coverage.find((item) => item.entryId === 'word-soap');

    assert.equal(phrase?.matched, true);
    assert.equal(phrase?.matchCount, 1);
    assert.equal(word?.matched, true);
    assert.equal(word?.matchCount, 1);
  });

  it('extracts editable vocabulary candidates from phrase timings only', () => {
    const candidates = extractLessonVocabularyCandidates([
      {
        id: 'item-1',
        text: 'Robert Iger watched soap operas in the fall.',
        wordTimings: [{ text: 'soap operas' }, { text: 'in the fall' }],
      },
    ]);

    assert.equal(candidates.get('soap operas')?.kind, 'PHRASE');
    assert.equal(candidates.get('in the fall')?.sourceItemId, 'item-1');
    assert.equal(candidates.has('robert'), false);
    assert.equal(candidates.has('soap'), false);
    assert.equal(candidates.has('fall'), false);
  });

  it('extracts editable vocabulary candidates from logical chunks', () => {
    const candidates = extractLessonVocabularyCandidates([
      {
        id: 'item-1',
        text: 'Robert Iger watched soap operas in the fall.',
        chunkTimings: [{ text: 'in the fall' }],
        wordTimings: [{ text: 'fall' }],
      },
    ]);

    assert.equal(candidates.get('in the fall')?.kind, 'PHRASE');
    assert.equal(candidates.get('in the fall')?.focusNormalizedText, 'fall');
    assert.equal(candidates.get('fall')?.kind, 'WORD');
  });

  it('can extract timing-only terms without sentence punctuation noise', () => {
    const candidates = extractLessonVocabularyCandidates([
      {
        id: 'item-1',
        text: '',
        wordTimings: [{ text: 'romance.' }, { text: 'Robert Iger' }],
      },
    ]);

    assert.equal(candidates.size, 2);
    assert.equal(candidates.get('romance')?.kind, 'WORD');
    assert.equal(candidates.get('robert iger')?.kind, 'PHRASE');
  });
});
