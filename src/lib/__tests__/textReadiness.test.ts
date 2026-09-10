import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { computeTextReadiness, type ReadinessEntryInput } from '../textReadiness';

function entry(overrides: Partial<ReadinessEntryInput> = {}): ReadinessEntryInput {
  return {
    id: 'entry-1',
    selected: true,
    hasNonBlankTranslation: true,
    hasCurrentClip: true,
    ...overrides,
  };
}

describe('computeTextReadiness', () => {
  it('is not ready when narration is missing, regardless of entries', () => {
    const result = computeTextReadiness({ narrationStatus: 'MISSING', alignmentStatus: 'MISSING', entries: [] });
    assert.equal(result.readyForApproval, false);
    assert.ok(result.reasonCodes.includes('NARRATION_MISSING'));
  });

  it('is not ready when alignment needs review', () => {
    const result = computeTextReadiness({ narrationStatus: 'READY', alignmentStatus: 'NEEDS_REVIEW', entries: [] });
    assert.equal(result.readyForApproval, false);
    assert.ok(result.reasonCodes.includes('ALIGNMENT_NEEDS_REVIEW'));
  });

  it('allows zero selections as a valid ready state ("no learning words selected")', () => {
    const result = computeTextReadiness({ narrationStatus: 'READY', alignmentStatus: 'OK', entries: [] });
    assert.equal(result.readyForApproval, true);
    assert.equal(result.selectedCount, 0);
    assert.ok(result.reasonCodes.includes('NO_WORDS_SELECTED'));
  });

  it('unselected entries never block readiness even if missing translation/clip', () => {
    const result = computeTextReadiness({
      narrationStatus: 'READY',
      alignmentStatus: 'OK',
      entries: [entry({ id: 'a', selected: false, hasNonBlankTranslation: false, hasCurrentClip: false })],
    });
    assert.equal(result.readyForApproval, true);
    assert.equal(result.selectedCount, 0);
  });

  it('only counts selected-and-incomplete entries as blocking, distinct from deliberately excluded', () => {
    const result = computeTextReadiness({
      narrationStatus: 'READY',
      alignmentStatus: 'OK',
      entries: [
        entry({ id: 'complete', selected: true, hasNonBlankTranslation: true, hasCurrentClip: true }),
        entry({ id: 'missing-translation', selected: true, hasNonBlankTranslation: false, hasCurrentClip: true }),
        entry({ id: 'missing-clip', selected: true, hasNonBlankTranslation: true, hasCurrentClip: false }),
        entry({ id: 'excluded', selected: false, hasNonBlankTranslation: false, hasCurrentClip: false }),
      ],
    });
    assert.equal(result.selectedCount, 3);
    assert.equal(result.selectedMissingTranslationCount, 1);
    assert.equal(result.selectedMissingClipCount, 1);
    assert.deepEqual(result.eligibleEntryIds, ['complete']);
    assert.equal(result.readyForApproval, false);
  });

  it('is ready when every selected entry has both translation and a current clip', () => {
    const result = computeTextReadiness({
      narrationStatus: 'READY',
      alignmentStatus: 'OK',
      entries: [entry({ id: 'a' }), entry({ id: 'b' })],
    });
    assert.equal(result.readyForApproval, true);
    assert.deepEqual(result.eligibleEntryIds.sort(), ['a', 'b']);
  });
});
