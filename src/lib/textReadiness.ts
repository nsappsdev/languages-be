export type NarrationStatus = 'READY' | 'MISSING' | 'FAILED';
export type AlignmentStatus = 'OK' | 'NEEDS_REVIEW' | 'MISSING';
export interface ReadinessEntryInput {
  id: string; selected: boolean; hasNonBlankTranslation: boolean; hasCurrentClip: boolean;
}
export interface ComputeTextReadinessInput {
  narrationStatus: NarrationStatus; alignmentStatus: AlignmentStatus; entries: ReadinessEntryInput[];
}
export interface TextReadinessResult {
  narrationValid: boolean;
  alignmentStatus: AlignmentStatus;
  selectedCount: number;
  selectedMissingTranslationCount: number;
  selectedMissingClipCount: number;
  eligibleEntryIds: string[];
  canPublish: boolean;
  readyForPublication: boolean;
  reasonCodes: string[];
}
export function computeTextReadiness(input: ComputeTextReadinessInput): TextReadinessResult {
  const reasonCodes: string[] = [];
  const narrationValid = input.narrationStatus === 'READY';
  if (!narrationValid) reasonCodes.push(input.narrationStatus === 'MISSING' ? 'NARRATION_MISSING' : 'NARRATION_FAILED');
  if (input.alignmentStatus !== 'OK') reasonCodes.push(input.alignmentStatus === 'MISSING' ? 'ALIGNMENT_MISSING' : 'ALIGNMENT_NEEDS_REVIEW');
  const selected = input.entries.filter(entry => entry.selected);
  const selectedMissingTranslationCount = selected.filter(entry => !entry.hasNonBlankTranslation).length;
  const selectedMissingClipCount = selected.filter(entry => !entry.hasCurrentClip).length;
  if (selectedMissingTranslationCount) reasonCodes.push('SELECTED_MISSING_TRANSLATION');
  if (selectedMissingClipCount) reasonCodes.push('SELECTED_MISSING_CLIP');
  const canPublish = narrationValid && input.alignmentStatus === 'OK' && selectedMissingTranslationCount === 0;
  return { narrationValid, alignmentStatus: input.alignmentStatus, selectedCount: selected.length,
    selectedMissingTranslationCount, selectedMissingClipCount,
    eligibleEntryIds: selected.filter(entry => entry.hasNonBlankTranslation && entry.hasCurrentClip).map(entry => entry.id),
    canPublish, readyForPublication: canPublish && selectedMissingClipCount === 0, reasonCodes };
}
