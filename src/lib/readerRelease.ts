import crypto from 'crypto';
import { AudioAsset, Prisma } from '@prisma/client';
import { readAudioAssetRange } from './audioAssetStorage';
import { computeTextReadiness } from './textReadiness';
import { computeContiguousCutBoundaries } from './wordClipExtraction';
import { ReaderAsset, ReaderText } from '../types/reader';
import { assertNonOverlappingRanges, resolveVocabularyRange } from './vocabularyRanges';

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

/** One readiness calculation for the admin UI and learner publication. */
export async function inspectReaderDraft(db: Db, textId: string) {
  const workspace = await db.textWorkspace.findUniqueOrThrow({ where: { textId } });
  const [revision, narration, alignment, entries, activeNarration] = await Promise.all([
    db.textContentRevision.findUnique({ where: { id: workspace.currentContentRevisionId ?? '' } }),
    db.textNarration.findUnique({ where: { id: workspace.currentNarrationId ?? '' }, include: { asset: true } }),
    db.textAlignment.findUnique({ where: { id: workspace.currentAlignmentId ?? '' }, include: { occurrences: { orderBy: { ordinal: 'asc' } } } }),
    db.textVocabularyEntry.findMany({ where: { textId, alignmentId: workspace.currentAlignmentId ?? '', archivedAt: null },
      include: { translations: true, wordClips: { include: { asset: true } } } }),
    db.audioJob.findFirst({ where: { textId, kind: 'GENERATE_NARRATION', status: { in: ['QUEUED', 'RUNNING'] } } }),
  ]);
  const narrationValid = !activeNarration && !workspace.archivedAt && !!revision && revision.textId === textId && !!narration && narration.textId === textId &&
    narration.provider === 'elevenlabs' && narration.asset.kind === 'NARRATION' && narration.asset.textId === textId && narration.contentRevisionId === revision.id && narration.inputTextSha256 === revision.textSha256 && validReaderAsset(narration.asset);
  const lineageValid = narrationValid && !!alignment && alignment.textId === textId &&
    alignment.contentRevisionId === revision.id && alignment.narrationId === narration.id && alignment.status === 'OK' &&
    alignment.occurrences.length > 0 && alignment.occurrences.every(o => o.mappingStatus === 'MAPPED' &&
      o.speechStartSample !== null && o.speechEndSample !== null && o.speechStartSample >= 0 &&
      o.speechEndSample > o.speechStartSample && o.speechEndSample <= narration.asset.frameCount! &&
      revision.text.slice(o.charStart, o.charEnd) === o.surfaceText);
  const boundaries = lineageValid ? computeContiguousCutBoundaries(alignment!.occurrences.map(o => ({
    ordinal: o.ordinal, speechStartSample: o.speechStartSample!, speechEndSample: o.speechEndSample!,
  })), narration!.asset.frameCount!) : null;
  let alignmentValid = lineageValid && boundaries?.status === 'OK';
  try { assertNonOverlappingRanges(alignment?.occurrences ?? [], entries.filter(entry => entry.selected)); }
  catch { alignmentValid = false; }
  const cuts = new Map(boundaries?.cuts.map(c => [c.ordinal, c]) ?? []);
  const vocabularyCuts = new Map<string, { startSample: number; endSample: number }>();
  const ranges = new Map<string, ReturnType<typeof resolveVocabularyRange>>();
  if (alignmentValid && alignment) for (const entry of entries) {
    try {
      const range = resolveVocabularyRange(alignment.occurrences, entry);
      ranges.set(entry.occurrenceId, range);
      vocabularyCuts.set(entry.occurrenceId, { startSample: cuts.get(range.first.ordinal)!.startSample, endSample: cuts.get(range.last.ordinal)!.endSample });
    } catch { /* Invalid inactive historical entries do not participate in publication. */ }
  }
  const clips = new Map(entries.map(entry => [entry.id, entry.wordClips.find(clip =>
    alignmentValid && clip.textId === textId && clip.narrationId === narration!.id && clip.alignmentId === alignment!.id &&
    clip.occurrenceId === entry.occurrenceId && clip.entryId === entry.id && clip.asset.textId === textId && clip.asset.kind === 'WORD_CLIP' &&
    vocabularyCuts.get(entry.occurrenceId)?.startSample === clip.startSample && vocabularyCuts.get(entry.occurrenceId)?.endSample === clip.endSample &&
    clip.startSample >= 0 && clip.endSample > clip.startSample && clip.endSample <= narration!.asset.frameCount! &&
    clip.asset.frameCount === clip.endSample - clip.startSample && clip.asset.sampleRate === narration!.asset.sampleRate &&
    validReaderAsset(clip.asset))]));
  const readiness = computeTextReadiness({
    narrationStatus: narrationValid ? 'READY' : 'MISSING',
    alignmentStatus: alignmentValid ? 'OK' : alignment?.status === 'NEEDS_REVIEW' || boundaries?.status === 'CUT_REVIEW_REQUIRED' ? 'NEEDS_REVIEW' : 'MISSING',
    entries: entries.map(entry => ({ id: entry.id, selected: entry.selected,
      hasNonBlankTranslation: entry.translations.some(t => ['hy', 'am'].includes(t.languageCode) && t.translation.trim()), hasCurrentClip: !!clips.get(entry.id) })),
  });
  let snapshot: ReaderText | null = null;
  if (readiness.readyForPublication && revision && narration && alignment) {
    const selected = new Map(entries.filter(e => e.selected).map(e => [e.occurrenceId, e]));
    const phraseMembers = new Set(entries.filter(entry => entry.selected).flatMap(entry => ranges.get(entry.occurrenceId)?.members.slice(1).map(word => word.id) ?? []));
    const sentences = alignment.sentences as unknown as { id: string; text: string; charStart: number; charEnd: number }[];
    snapshot = {
      textId, textReleaseId: '', contentRevisionId: revision.id, narrationId: narration.id, alignmentId: alignment.id,
      text: revision.text, sourceLanguage: revision.sourceLanguage, narration: assetDto(narration.asset),
      sentences: sentences.map(sentence => {
        const words = alignment.occurrences.filter(o => o.sentenceId === sentence.id);
        return { ...sentence, startSample: words[0]?.speechStartSample ?? 0,
          endSample: words[words.length - 1]?.speechEndSample ?? 0 };
      }),
      occurrences: alignment.occurrences.filter(o => !phraseMembers.has(o.id)).map(o => {
        const entry = selected.get(o.id);
        const clip = entry ? clips.get(entry.id) : undefined;
        const last = entry ? ranges.get(o.id)!.last : o;
        return { id: o.id, ordinal: o.ordinal, text: revision.text.slice(o.charStart, last.charEnd), charStart: o.charStart, charEnd: last.charEnd,
          sentenceId: o.sentenceId, startSample: o.speechStartSample!, endSample: last.speechEndSample!,
          learning: entry && clip ? { entryId: entry.id,
            translations: entry.translations.filter(t => t.translation.trim()).map(t => ({
              languageCode: t.languageCode === 'am' ? 'hy' : t.languageCode, translation: t.translation.trim() })),
            clip: assetDto(clip.asset), cutStartSample: clip.startSample, cutEndSample: clip.endSample } : null };
      }),
    };
  }
  if (activeNarration) readiness.reasonCodes.push('NARRATION_IN_PROGRESS');
  return { workspace, readiness, snapshot, revision, narration, alignment, clips, cuts, vocabularyCuts,
    missingClipOccurrenceIds: entries.filter(e => e.selected && !clips.get(e.id)).map(e => e.occurrenceId) };
}

export function readerAssetIds(text: ReaderText) {
  return [text.narration.id, ...text.occurrences.flatMap(o => o.learning ? [o.learning.clip.id] : [])];
}
