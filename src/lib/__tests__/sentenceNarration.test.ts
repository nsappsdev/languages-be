import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { splitSentences } from '../sentenceSegmentation';
import { assembleSentences } from '../sentenceNarration';
import { buildTextAlignment } from '../textOccurrenceAlignment';

describe('sentence audio boundaries and assembly', () => {
  it('keeps abbreviations, decimals, closing quotes and original source offsets', () => {
    const text = '  Dr. Smith paid 3.50 dollars. "Really?"  Yes!  ';
    const spans = splitSentences(text);
    assert.deepEqual(spans.map(span => span.text), ['Dr. Smith paid 3.50 dollars.', '"Really?"', 'Yes!']);
    for (const span of spans) assert.equal(text.slice(span.charStart, span.charEnd), span.text);
    assert.equal(splitSentences(text, 'en', [text.length]).length, 1);
    assert.throws(() => splitSentences(text, 'en', [8, text.length]), /between words/);
    assert.throws(() => splitSentences(text, 'en', [10]), /complete saved text/);
  });

  it('joins exact samples and rebases real character timings across whitespace and Unicode', () => {
    const text = ' Hi 😀.\n\nHello! ';
    const spans = splitSentences(text);
    const recordings = spans.map((span, index) => {
      const characters = Array.from(span.text);
      const samples = new Int16Array((characters.length + 2) * 240).fill(index + 1);
      return { assetId: `sentence-${index}`, audio: { sampleRate: 24000, channels: 1, bitsPerSample: 16, frameCount: samples.length, samples },
        alignment: { characters, character_start_times_seconds: characters.map((_, i) => i * 0.01),
          character_end_times_seconds: characters.map((_, i) => (i + 1) * 0.01) } };
    });
    const result = assembleSentences(text, spans, recordings);
    assert.deepEqual(result.audio.samples, Int16Array.from(recordings.flatMap(item => [...item.audio.samples])));
    assert.equal(result.alignment!.characters.join(''), text);
    const mapping = buildTextAlignment({ text, alignment: result.alignment, algorithmVersion: 1, sentenceSpans: spans });
    assert.equal(mapping.status, 'OK');
    assert.equal(mapping.occurrences[1].surfaceText, 'Hello');
    assert.equal(mapping.occurrences[1].speechStartSample, recordings[0].audio.frameCount);
    assert.equal(result.sentences[1].startSample, recordings[0].audio.frameCount);
    const invalid = assembleSentences(text, spans, [{ ...recordings[0], alignment: null }, recordings[1]]);
    assert.equal(invalid.alignment, null);
  });
});
