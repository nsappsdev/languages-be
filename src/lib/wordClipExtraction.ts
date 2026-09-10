import { DecodedWav, sliceWavBySample } from './pcmWav';

/**
 * Proposed default contiguous partition cut policy (plan §6.2): every sample
 * of the canonical narration belongs to exactly one occurrence's cut span,
 * with internal boundaries placed at the nearest-sample midpoint between the
 * previous word's speech end and the next word's speech start. This is our
 * cut policy, not a documented provider algorithm.
 */

export interface OccurrenceForCutPolicy {
  ordinal: number;
  speechStartSample: number;
  speechEndSample: number;
}

export interface CutBoundary {
  ordinal: number;
  startSample: number;
  endSample: number;
}

export type CutBoundaryResult =
  | { status: 'OK'; cuts: CutBoundary[] }
  | { status: 'CUT_REVIEW_REQUIRED'; cuts: [] };

export function computeContiguousCutBoundaries(
  occurrencesInOrder: OccurrenceForCutPolicy[],
  totalFrames: number,
): CutBoundaryResult {
  for (let i = 0; i < occurrencesInOrder.length; i += 1) {
    const occurrence = occurrencesInOrder[i];
    if (occurrence.speechEndSample <= occurrence.speechStartSample) {
      return { status: 'CUT_REVIEW_REQUIRED', cuts: [] };
    }
    if (occurrence.speechStartSample < 0 || occurrence.speechEndSample > totalFrames) {
      return { status: 'CUT_REVIEW_REQUIRED', cuts: [] };
    }
    if (i > 0 && occurrence.speechStartSample < occurrencesInOrder[i - 1].speechEndSample) {
      return { status: 'CUT_REVIEW_REQUIRED', cuts: [] };
    }
  }

  if (!occurrencesInOrder.length) {
    return { status: 'OK', cuts: [] };
  }

  const innerBoundaries: number[] = [];
  for (let i = 1; i < occurrencesInOrder.length; i += 1) {
    const gapStart = occurrencesInOrder[i - 1].speechEndSample;
    const gapEnd = occurrencesInOrder[i].speechStartSample;
    innerBoundaries.push(Math.round((gapStart + gapEnd) / 2));
  }

  const boundaries = [0, ...innerBoundaries, totalFrames];
  const cuts: CutBoundary[] = occurrencesInOrder.map((occurrence, i) => ({
    ordinal: occurrence.ordinal,
    startSample: boundaries[i],
    endSample: boundaries[i + 1],
  }));

  return { status: 'OK', cuts };
}

export function extractWordClip(narration: DecodedWav, startSample: number, endSample: number): DecodedWav {
  return sliceWavBySample(narration, startSample, endSample);
}
