/**
 * Deterministic, dependency-free reader/writer for uncompressed PCM WAV audio.
 *
 * Scope is intentionally narrow: mono, 16-bit little-endian, 24000 Hz only,
 * which is what the ElevenLabs `wav_24000` output format and this authoring
 * pipeline both use end to end. Anything else fails loudly instead of being
 * silently reinterpreted, per the "no raw-byte reinterpretation" requirement.
 */

export const REQUIRED_SAMPLE_RATE = 24000;
export const REQUIRED_CHANNELS = 1;
export const REQUIRED_BITS_PER_SAMPLE = 16;
const PCM_FORMAT = 1;

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  frameCount: number;
  samples: Int16Array;
}

export interface EncodeWavInput {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  samples: Int16Array;
}

function findChunk(buffer: Buffer, id: string, searchStart: number): { offset: number; size: number } {
  let offset = searchStart;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === id) {
      return { offset: offset + 8, size: chunkSize };
    }
    // Chunks are word-aligned: odd-sized chunks have one byte of padding.
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error(`WAV missing required "${id}" chunk`);
}

export function decodeWav(buffer: Buffer): DecodedWav {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Not a valid WAV file: missing RIFF header');
  }
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a valid WAV file: missing WAVE format identifier');
  }

  const fmt = findChunk(buffer, 'fmt ', 12);
  const audioFormat = buffer.readUInt16LE(fmt.offset);
  if (audioFormat !== PCM_FORMAT) {
    throw new Error(`Unsupported WAV audio format ${audioFormat}: only uncompressed PCM is supported`);
  }
  const channels = buffer.readUInt16LE(fmt.offset + 2);
  const sampleRate = buffer.readUInt32LE(fmt.offset + 4);
  const byteRate = buffer.readUInt32LE(fmt.offset + 8);
  const blockAlign = buffer.readUInt16LE(fmt.offset + 12);
  const bitsPerSample = buffer.readUInt16LE(fmt.offset + 14);

  if (sampleRate !== REQUIRED_SAMPLE_RATE) {
    throw new Error(`Unsupported WAV sample rate ${sampleRate}: only ${REQUIRED_SAMPLE_RATE} is supported`);
  }
  if (channels !== REQUIRED_CHANNELS) {
    throw new Error(`Unsupported WAV channel count ${channels}: only mono audio is supported`);
  }
  if (bitsPerSample !== REQUIRED_BITS_PER_SAMPLE) {
    throw new Error(`Unsupported WAV bit depth ${bitsPerSample}: only 16-bit PCM is supported`);
  }
  const expectedBlockAlign = channels * (bitsPerSample / 8);
  if (blockAlign !== expectedBlockAlign) {
    throw new Error('WAV block align does not match declared channels/bit depth');
  }
  const expectedByteRate = sampleRate * blockAlign;
  if (byteRate !== expectedByteRate) {
    throw new Error('WAV byte rate does not match declared sample rate/block align');
  }

  const data = findChunk(buffer, 'data', 12);
  if (data.offset + data.size > buffer.length) {
    throw new Error('WAV data chunk declares more bytes than are present in the file');
  }
  if (data.size % blockAlign !== 0) {
    throw new Error('WAV data chunk size is not a whole number of frames');
  }

  const frameCount = data.size / blockAlign;
  const samples = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    samples[i] = buffer.readInt16LE(data.offset + i * 2);
  }

  return { sampleRate, channels, bitsPerSample, frameCount, samples };
}

export function encodeWav(input: EncodeWavInput): Buffer {
  const { sampleRate, channels, bitsPerSample, samples } = input;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * (bitsPerSample / 8);

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(PCM_FORMAT, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buffer;
}

/**
 * Nearest-sample rounding, versioned as "v1": floor(seconds * sampleRate + 0.5).
 * Any future rounding-policy change must be a new named version, not a silent
 * behavior change, since it affects committed clip provenance.
 */
export function secondsToSampleIndex(seconds: number, sampleRate: number): number {
  if (!Number.isFinite(seconds)) {
    throw new Error('secondsToSampleIndex requires a finite seconds value');
  }
  if (seconds < 0) {
    throw new Error('secondsToSampleIndex requires a nonnegative seconds value');
  }
  return Math.floor(seconds * sampleRate + 0.5);
}

export function sliceWavBySample(
  decoded: DecodedWav,
  startSample: number,
  endSample: number,
): DecodedWav {
  if (!Number.isInteger(startSample) || !Number.isInteger(endSample)) {
    throw new Error('sliceWavBySample requires integer sample indices');
  }
  if (endSample <= startSample) {
    throw new Error('sliceWavBySample requires a nonincreasing/inverted range rejection: endSample must be greater than startSample');
  }
  if (startSample < 0 || endSample > decoded.frameCount) {
    throw new Error(
      `sliceWavBySample range [${startSample},${endSample}) is out of bounds for ${decoded.frameCount} frames`,
    );
  }

  return {
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
    bitsPerSample: decoded.bitsPerSample,
    frameCount: endSample - startSample,
    samples: decoded.samples.subarray(startSample, endSample),
  };
}
