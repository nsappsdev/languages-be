import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { decodeWav, encodeWav, sliceWavBySample, secondsToSampleIndex } from '../pcmWav';

function buildWav(samples: number[], sampleRate = 24000): Buffer {
  return encodeWav({
    sampleRate,
    channels: 1,
    bitsPerSample: 16,
    samples: Int16Array.from(samples),
  });
}

describe('pcmWav', () => {
  it('round-trips a synthetic mono 16-bit PCM signal through encode/decode', () => {
    const samples = [0, 100, -100, 32767, -32768, 5000];
    const wav = buildWav(samples);
    const decoded = decodeWav(wav);

    assert.equal(decoded.sampleRate, 24000);
    assert.equal(decoded.channels, 1);
    assert.equal(decoded.bitsPerSample, 16);
    assert.equal(decoded.frameCount, samples.length);
    assert.deepEqual(Array.from(decoded.samples), samples);
  });

  it('rejects a non-RIFF buffer', () => {
    assert.throws(() => decodeWav(Buffer.from('not a wav file at all')), /RIFF/);
  });

  it('rejects compressed (non-PCM) audio format', () => {
    const wav = buildWav([0, 1, 2]);
    // audioFormat is a little-endian uint16 at byte offset 20 of a canonical WAV.
    wav.writeUInt16LE(3, 20);
    assert.throws(() => decodeWav(wav), /PCM/);
  });

  it('rejects unsupported sample rate/channel/bit depth combinations', () => {
    assert.throws(() => decodeWav(buildWav([0, 1], 44100)), /24000/);
    assert.throws(
      () =>
        decodeWav(
          encodeWav({
            sampleRate: 24000,
            channels: 2,
            bitsPerSample: 16,
            samples: Int16Array.from([0, 0, 1, 1]),
          }),
        ),
      /mono/,
    );
  });

  it('parses through an unknown extra chunk placed before data', () => {
    const wav = buildWav([1, 2, 3]);
    const junk = Buffer.from('JUNK\x04\x00\x00\x00\x01\x02\x03\x04', 'binary');
    const riffSize = wav.readUInt32LE(4) + junk.length;
    const withJunk = Buffer.concat([wav.subarray(0, 4), Buffer.alloc(4), wav.subarray(8, 36), junk, wav.subarray(36)]);
    withJunk.writeUInt32LE(riffSize, 4);
    const decoded = decodeWav(withJunk);
    assert.deepEqual(Array.from(decoded.samples), [1, 2, 3]);
  });

  it('computes nearest-sample index from seconds deterministically', () => {
    assert.equal(secondsToSampleIndex(0, 24000), 0);
    assert.equal(secondsToSampleIndex(1, 24000), 24000);
    assert.equal(secondsToSampleIndex(0.5, 24000), 12000);
    // 0.0000208333s * 24000 = 0.4999992 -> rounds to nearest (0)
    assert.equal(secondsToSampleIndex(0.0000208333, 24000), 0);
    // exact .5 boundary rounds up (floor(x+0.5))
    assert.equal(secondsToSampleIndex(1 / 48000, 24000), 1);
  });

  it('rejects negative or non-finite seconds', () => {
    assert.throws(() => secondsToSampleIndex(-1, 24000), /nonnegative/);
    assert.throws(() => secondsToSampleIndex(NaN, 24000), /finite/);
  });

  it('slices exact sample ranges producing a valid standalone WAV', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80];
    const wav = buildWav(samples);
    const decoded = decodeWav(wav);
    const clip = sliceWavBySample(decoded, 2, 5);
    assert.equal(clip.frameCount, 3);
    assert.deepEqual(Array.from(clip.samples), [30, 40, 50]);

    const reencoded = encodeWav(clip);
    const redecoded = decodeWav(reencoded);
    assert.deepEqual(Array.from(redecoded.samples), [30, 40, 50]);
  });

  it('rejects inverted or out-of-bounds slice ranges', () => {
    const decoded = decodeWav(buildWav([1, 2, 3, 4]));
    assert.throws(() => sliceWavBySample(decoded, 3, 2), /inverted|nonincreasing/i);
    assert.throws(() => sliceWavBySample(decoded, -1, 2), /bounds/i);
    assert.throws(() => sliceWavBySample(decoded, 0, 5), /bounds/i);
  });

  it('reconstructs the full narration exactly when slicing all contiguous partitions', () => {
    const samples = Array.from({ length: 100 }, (_, i) => (i % 7) * 100 - 300);
    const decoded = decodeWav(buildWav(samples));
    const boundaries = [0, 20, 45, 100];
    const parts: number[] = [];
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      const slice = sliceWavBySample(decoded, boundaries[i], boundaries[i + 1]);
      parts.push(...Array.from(slice.samples));
    }
    assert.deepEqual(parts, samples);
  });
});
