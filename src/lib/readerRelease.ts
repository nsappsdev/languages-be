import crypto from 'crypto';
import { AudioAsset, Prisma } from '@prisma/client';
import { readAudioAssetRange } from './audioAssetStorage';
import { computeTextReadiness } from './textReadiness';
import { ReaderAsset, ReaderText } from '../types/reader';

type Db = Prisma.TransactionClient;

export class ReaderReleaseError extends Error {
  constructor(public status: number, message: string, public details: Record<string, unknown> = {}) { super(message); }
}

export function validReaderAsset(asset: AudioAsset | null | undefined): asset is AudioAsset {
  if (!asset || asset.state !== 'READY' || !asset.sampleRate || !asset.frameCount || asset.byteLength <= 0) return false;
  try {
    const stored = readAudioAssetRange(asset.storageKey, 0, asset.byteLength);
    return !!stored && stored.totalLength === asset.byteLength &&
      crypto.createHash('sha256').update(stored.buffer).digest('hex') === asset.sha256;
  } catch {
    return false;
  }
}

function assetDto(asset: AudioAsset): ReaderAsset {
  return { id: asset.id, sha256: asset.sha256, mimeType: asset.mimeType, byteLength: asset.byteLength,
    sampleRate: asset.sampleRate!, frameCount: asset.frameCount! };
}

/** One readiness calculation for the admin UI, approval, and learner publication. */
export async function inspectReaderDraft(db: Db, textId: string) {
  const workspace = await db.textWorkspace.findUniqueOrThrow({ where: { textId } });
  const [revision, narration, alignment, entries] = await Promise.all([
    db.textContentRevision.findUnique({ where: { id: workspace.currentContentRevisionId ?? '' } }),
    db.textNarration.findUnique({ where: { id: workspace.currentNarrationId ?? '' }, include: { asset: true } }),
    db.textAlignment.findUnique({ where: { id: workspace.currentAlignmentId ?? '' }, include: { occurrences: { orderBy: { ordinal: 'asc' } } } }),
    db.textVocabularyEntry.findMany({ where: { textId, alignmentId: workspace.currentAlignmentId ?? '', archivedAt: null },
      include: { translations: true, wordClips: { include: { asset: true } } } }),
  ]);
  const narrationValid = !!revision && revision.textId === textId && !!narration && narration.textId === textId &&
    narration.contentRevisionId === revision.id && narration.inputTextSha256 === revision.textSha256 && validReaderAsset(narration.asset);
  const alignmentValid = narrationValid && !!alignment && alignment.textId === textId &&
    alignment.contentRevisionId === revision.id && alignment.narrationId === narration.id && alignment.status === 'OK' &&
    alignment.occurrences.length > 0 && alignment.occurrences.every(o => o.mappingStatus === 'MAPPED' &&
      o.speechStartSample !== null && o.speechEndSample !== null && o.speechStartSample >= 0 &&
      o.speechEndSample > o.speechStartSample && o.speechEndSample <= narration.asset.frameCount! &&
      revision.text.slice(o.charStart, o.charEnd) === o.surfaceText);
  const clips = new Map(entries.map(entry => [entry.id, entry.wordClips.find(clip =>
    alignmentValid && clip.textId === textId && clip.narrationId === narration!.id && clip.alignmentId === alignment!.id &&
    clip.occurrenceId === entry.occurrenceId && alignment!.occurrences.some(o => o.id === clip.occurrenceId) &&
    clip.startSample >= 0 && clip.endSample > clip.startSample && clip.endSample <= narration!.asset.frameCount! &&
    clip.asset.frameCount === clip.endSample - clip.startSample && clip.asset.sampleRate === narration!.asset.sampleRate &&
    validReaderAsset(clip.asset))]));
  const readiness = computeTextReadiness({
    narrationStatus: narrationValid ? 'READY' : 'MISSING',
    alignmentStatus: alignmentValid ? 'OK' : alignment?.status === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'MISSING',
    entries: entries.map(entry => ({ id: entry.id, selected: entry.selected,
      hasNonBlankTranslation: entry.translations.some(t => t.translation.trim()), hasCurrentClip: !!clips.get(entry.id) })),
  });
  let snapshot: ReaderText | null = null;
  if (readiness.readyForApproval && revision && narration && alignment) {
    const selected = new Map(entries.filter(e => e.selected).map(e => [e.occurrenceId, e]));
    const sentences = alignment.sentences as unknown as { id: string; text: string; charStart: number; charEnd: number }[];
    snapshot = {
      textId, textReleaseId: '', contentRevisionId: revision.id, narrationId: narration.id, alignmentId: alignment.id,
      text: revision.text, sourceLanguage: revision.sourceLanguage, narration: assetDto(narration.asset),
      sentences: sentences.map(sentence => {
        const words = alignment.occurrences.filter(o => o.sentenceId === sentence.id);
        return { ...sentence, startSample: words[0]?.speechStartSample ?? 0,
          endSample: words[words.length - 1]?.speechEndSample ?? 0 };
      }),
      occurrences: alignment.occurrences.map(o => {
        const entry = selected.get(o.id);
        const clip = entry ? clips.get(entry.id) : undefined;
        return { id: o.id, ordinal: o.ordinal, text: o.surfaceText, charStart: o.charStart, charEnd: o.charEnd,
          sentenceId: o.sentenceId, startSample: o.speechStartSample!, endSample: o.speechEndSample!,
          learning: entry && clip ? { entryId: entry.id,
            translations: entry.translations.filter(t => t.translation.trim()).map(t => ({
              languageCode: t.languageCode === 'am' ? 'hy' : t.languageCode, translation: t.translation.trim() })),
            clip: assetDto(clip.asset), cutStartSample: clip.startSample, cutEndSample: clip.endSample } : null };
      }),
    };
  }
  return { workspace, readiness, snapshot };
}

export function readerAssetIds(text: ReaderText) {
  return [text.narration.id, ...text.occurrences.flatMap(o => o.learning ? [o.learning.clip.id] : [])];
}
