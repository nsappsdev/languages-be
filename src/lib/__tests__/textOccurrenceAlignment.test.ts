import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildTextAlignment,
  type ElevenLabsCharacterAlignment,
} from '../textOccurrenceAlignment';

function charAlignment(text: string, startPerChar: number, gapPerChar = 0): ElevenLabsCharacterAlignment {
  const characters = Array.from(text);
  const characterStartTimesSeconds: number[] = [];
  const characterEndTimesSeconds: number[] = [];
  let t = 0;
  for (let i = 0; i < characters.length; i += 1) {
    characterStartTimesSeconds.push(t);
    const dur = startPerChar;
    t += dur;
    characterEndTimesSeconds.push(t);
    t += gapPerChar;
  }
  return { characters, character_start_times_seconds: characterStartTimesSeconds, character_end_times_seconds: characterEndTimesSeconds };
}

describe('textOccurrenceAlignment', () => {
  it('maps distinct offsets for repeated words in order', () => {
    const text = 'The cat sat on the mat with the cat.';
    const alignment = charAlignment(text, 0.05);
    const result = buildTextAlignment({ text, alignment, algorithmVersion: 1 });

    assert.equal(result.status, 'OK');
    const catOccurrences = result.occurrences.filter((o) => o.normalizedText === 'cat');
    assert.equal(catOccurrences.length, 2);
    assert.notEqual(catOccurrences[0].charStart, catOccurrences[1].charStart);
    assert.equal(text.slice(catOccurrences[0].charStart, catOccurrences[0].charEnd), 'cat');
    assert.equal(text.slice(catOccurrences[1].charStart, catOccurrences[1].charEnd), 'cat');
    // occurrences ordered strictly by ordinal/position
    for (let i = 1; i < result.occurrences.length; i += 1) {
      assert.ok(result.occurrences[i].charStart >= result.occurrences[i - 1].charStart);
    }
  });

  it('preserves apostrophes as part of the word surface text', () => {
    const text = "Mark's book is here.";
    const alignment = charAlignment(text, 0.05);
    const result = buildTextAlignment({ text, alignment, algorithmVersion: 1 });
    const first = result.occurrences[0];
    assert.equal(text.slice(first.charStart, first.charEnd), "Mark's");
  });

  it('groups occurrences into sentences with min/max speech extent', () => {
    const text = 'Hello world. Goodbye now.';
    const alignment = charAlignment(text, 0.05);
    const result = buildTextAlignment({ text, alignment, algorithmVersion: 1 });
    assert.equal(result.sentences.length, 2);
    assert.equal(result.sentences[0].text, 'Hello world.');
    assert.equal(result.sentences[1].text, 'Goodbye now.');
    const firstSentenceOccurrenceIds = result.sentences[0].occurrenceIds;
    assert.equal(firstSentenceOccurrenceIds.length, 2);
  });

  it('computes word speech onset/offset from first/last mapped spoken character', () => {
    const text = 'Hi there';
    const alignment = charAlignment(text, 0.1);
    const result = buildTextAlignment({ text, alignment, algorithmVersion: 1 });
    const hi = result.occurrences[0];
    // 'H' is char 0 -> start 0.0; 'i' is char 1 -> end at char_end_times[1] = 0.2
    assert.equal(hi.speechStartSample, Math.round(0 * 24000));
    assert.ok(hi.speechEndSample! > hi.speechStartSample!);
  });

  it('flags NEEDS_REVIEW when alignment is null', () => {
    const result = buildTextAlignment({ text: 'Some text.', alignment: null, algorithmVersion: 1 });
    assert.equal(result.status, 'NEEDS_REVIEW');
    assert.ok(result.diagnostics.some((d) => d.code === 'ALIGNMENT_MISSING'));
    assert.equal(result.occurrences.length, 0);
  });

  it('flags NEEDS_REVIEW when character array length mismatches timing arrays', () => {
    const text = 'Some text.';
    const alignment = charAlignment(text, 0.05);
    alignment.character_end_times_seconds.pop();
    const result = buildTextAlignment({ text, alignment, algorithmVersion: 1 });
    assert.equal(result.status, 'NEEDS_REVIEW');
    assert.ok(result.diagnostics.some((d) => d.code === 'ALIGNMENT_ARRAY_LENGTH_MISMATCH'));
  });

  it('flags NEEDS_REVIEW when provider characters cannot reconstruct source text (normalization mismatch)', () => {
    const text = 'I have 3 cats.';
    // Provider "spoke" the normalized/expanded form instead of matching source exactly.
    const alignment = charAlignment('I have three cats.', 0.05);
    const result = buildTextAlignment({ text, alignment, algorithmVersion: 1 });
    assert.equal(result.status, 'NEEDS_REVIEW');
    assert.ok(result.diagnostics.some((d) => d.code === 'TEXT_ALIGNMENT_MISMATCH'));
  });

  it('rejects non-finite or non-monotonic character timings as diagnostics rather than throwing', () => {
    const text = 'Bad timing here.';
    const alignment = charAlignment(text, 0.05);
    alignment.character_start_times_seconds[2] = Number.NaN;
    const result = buildTextAlignment({ text, alignment, algorithmVersion: 1 });
    assert.equal(result.status, 'NEEDS_REVIEW');
    assert.ok(result.diagnostics.some((d) => d.code === 'NON_FINITE_TIMING'));
  });

  it('does not select punctuation-only spans as occurrences', () => {
    const text = 'Wait... really?';
    const alignment = charAlignment(text, 0.05);
    const result = buildTextAlignment({ text, alignment, algorithmVersion: 1 });
    const surfaces = result.occurrences.map((o) => text.slice(o.charStart, o.charEnd));
    assert.deepEqual(surfaces, ['Wait', 'really']);
  });
});
