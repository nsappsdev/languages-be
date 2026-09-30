import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { encodeWav, decodeWav } from '../pcmWav';
import {
  computeContiguousCutBoundaries,
  extractWordClip,
  type OccurrenceForCutPolicy,
} from '../wordClipExtraction';

function wav(samples: number[]) {
  return encodeWav({ sampleRate: 24000, channels: 1, bitsPerSample: 16, samples: Int16Array.from(samples) });
}

describe('wordClipExtraction cut policy', () => {
  it('computes contiguous nearest-sample-midpoint boundaries covering [0,N]', () => {
    const occurrences: OccurrenceForCutPolicy[] = [
      { ordinal: 0, speechStartSample: 10, speechEndSample: 20 },
      { ordinal: 1, speechStartSample: 30, speechEndSample: 40 },
      { ordinal: 2, speechStartSample: 50, speechEndSample: 60 },
    ];
    const result = computeContiguousCutBoundaries(occurrences, 100);
    assert.equal(result.status, 'OK');
    assert.equal(result.cuts.length, 3);
    assert.equal(result.cuts[0].startSample, 0);
    assert.equal(result.cuts[0].endSample, 25); // midpoint of 20 and 30
    assert.equal(result.cuts[1].startSample, 25);
    assert.equal(result.cuts[1].endSample, 45); // midpoint of 40 and 50
    assert.equal(result.cuts[2].startSample, 45);
    assert.equal(result.cuts[2].endSample, 100);
  });

  it('flags CUT_REVIEW_REQUIRED on overlapping/non-increasing speech spans', () => {
    const occurrences: OccurrenceForCutPolicy[] = [
      { ordinal: 0, speechStartSample: 10, speechEndSample: 40 },
      { ordinal: 1, speechStartSample: 20, speechEndSample: 50 },
    ];
    const result = computeContiguousCutBoundaries(occurrences, 100);
    assert.equal(result.status, 'CUT_REVIEW_REQUIRED');
  });

  it('reconstructs full narration exactly by extracting cuts for every occurrence', () => {
    const samples = Array.from({ length: 120 }, (_, i) => (i * 37) % 200 - 100);
    const decoded = decodeWav(wav(samples));
    const occurrences: OccurrenceForCutPolicy[] = [
      { ordinal: 0, speechStartSample: 10, speechEndSample: 20 },
      { ordinal: 1, speechStartSample: 40, speechEndSample: 50 },
      { ordinal: 2, speechStartSample: 90, speechEndSample: 100 },
    ];
    const boundaries = computeContiguousCutBoundaries(occurrences, decoded.frameCount);
    assert.equal(boundaries.status, 'OK');
    const reconstructed: number[] = [];
    for (const cut of boundaries.cuts) {
      const clip = extractWordClip(decoded, cut.startSample, cut.endSample);
      reconstructed.push(...Array.from(clip.samples));
    }
    assert.deepEqual(reconstructed, samples);
  });

  it('extracts only the requested selected-occurrence clip bytes, matching the exact narration slice', () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const decoded = decodeWav(wav(samples));
    const clip = extractWordClip(decoded, 3, 7);
    assert.deepEqual(Array.from(clip.samples), [4, 5, 6, 7]);
  });
});
