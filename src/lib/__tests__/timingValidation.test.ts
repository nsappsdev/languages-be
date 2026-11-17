import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildTextAlignment } from '../textOccurrenceAlignment';
import { forcedAlignmentCharacters } from '../elevenLabsAlignment';

describe('untrusted provider timing validation', () => {
  it('does not mistake real provider loss scores for confidence percentages', () => {
    const result = forcedAlignmentCharacters({ loss: 0.8133196061657321, words: [{ text: 'SPY', loss: 1.0918744405110676 }],
      characters: [{ text: 'S', start: 1.62, end: 1.7 }, { text: 'P', start: 1.7, end: 2 }, { text: 'Y', start: 2, end: 2.02 }] });
    assert.equal(buildTextAlignment({ text: 'SPY', alignment: result, frameCount: 60186, algorithmVersion: 3 }).status, 'OK');
    for (const payload of [null, {}, { loss: 0.1, words: [null] }]) assert.throws(() => forcedAlignmentCharacters(payload));
  });
  it('returns diagnostics rather than throwing for malformed and negative timings', () => {
    for (const alignment of [null, false, 42, 'wrong', {}, { characters: ['A'] },
      { characters: [null], character_start_times_seconds: [0], character_end_times_seconds: [1] },
      { characters: ['A'], character_start_times_seconds: [-0.01], character_end_times_seconds: [1] },
      { characters: ['A'], character_start_times_seconds: [NaN], character_end_times_seconds: [1] },
      { characters: ['A'], character_start_times_seconds: [0], character_end_times_seconds: [Infinity] }]) {
      const result = buildTextAlignment({ text: 'A', alignment, frameCount: 24000, algorithmVersion: 3 });
      assert.equal(result.status, 'NEEDS_REVIEW');
      assert.ok(result.diagnostics.length);
    }
  });
  it('corrects only sub-millisecond boundary jitter without changing provider data', () => {
    const alignment = { characters: ['H', 'i'], character_start_times_seconds: [-0.00025, 0.49975], character_end_times_seconds: [0.5, 1.0005] };
    const original = structuredClone(alignment);
    const result = buildTextAlignment({ text: 'Hi', alignment, frameCount: 24000, algorithmVersion: 3 });
    assert.equal(result.status, 'OK');
    assert.equal(result.occurrences[0].speechStartSample, 0);
    assert.equal(result.occurrences[0].speechEndSample, 24000);
    assert.deepEqual(alignment, original);
  });
  it('rejects a single timestamp token shared by multiple words', () => {
    const result = buildTextAlignment({ text: 'Two words', alignment: { characters: ['Two words'], character_start_times_seconds: [0], character_end_times_seconds: [1] }, frameCount: 24000, algorithmVersion: 3 });
    assert.equal(result.status, 'NEEDS_REVIEW');
    assert.equal(result.diagnostics[0].code, 'NON_MONOTONIC_TIMING');
  });
  it('keeps punctuation, Unicode and number spelling anchored to the exact source', () => {
    for (const text of ['“Don’t pay $3.50.”', 'Անձրևանոց — raincoat.', '😀 Hello!']) {
      const characters = Array.from(text);
      const result = buildTextAlignment({ text, alignment: { characters,
        character_start_times_seconds: characters.map((_, i) => i * 0.1), character_end_times_seconds: characters.map((_, i) => (i + 1) * 0.1) },
        frameCount: characters.length * 2400, algorithmVersion: 3 });
      assert.equal(result.status, 'OK');
      assert.ok(result.occurrences.every(w => text.slice(w.charStart, w.charEnd) === w.surfaceText));
    }
    assert.equal(buildTextAlignment({ text: '14', alignment: { characters: ['fourteen'], character_start_times_seconds: [0], character_end_times_seconds: [1] }, algorithmVersion: 3 }).status, 'NEEDS_REVIEW');
  });
});
