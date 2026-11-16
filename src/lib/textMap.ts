import { Prisma, TextContentRevision } from '@prisma/client';
import { SentenceSpan, splitSentences } from './sentenceSegmentation';
import { TextAlignmentResult } from './textOccurrenceAlignment';
import { ReaderReleaseError } from './readerRelease';

/** Text identities exist before speech. Missing timings never hide selectable words. */
export function mapSourceText(text: string, spans: SentenceSpan[]): TextAlignmentResult {
  const occurrences = [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].map((match, ordinal) => ({
    ordinal, charStart: match.index!, charEnd: match.index! + match[0].length,
    sentenceIndex: spans.findIndex(span => match.index! >= span.charStart && match.index! + match[0].length <= span.charEnd),
    surfaceText: match[0], normalizedText: match[0].replace(/['’]/g, '').toLowerCase(),
    speechStartSample: null, speechEndSample: null, mappingStatus: 'UNMAPPED' as const,
  }));
  return { status: 'NEEDS_REVIEW', diagnostics: [], occurrences,
    sentences: spans.map((span, index) => ({ ...span, index, occurrenceIds: occurrences.filter(word => word.sentenceIndex === index).map(word => word.ordinal) })) };
}

export async function persistTextMap(tx: Prisma.TransactionClient, revision: TextContentRevision,
  mapping: TextAlignmentResult, narrationId: string | null = null,
  sentenceAudio: Array<{ startSample: number; endSample: number }> = []) {
  const workspace = await tx.textWorkspace.findUniqueOrThrow({ where: { textId: revision.textId } });
  const previous = workspace.currentAlignmentId ? await tx.textAlignment.findUnique({
    where: { id: workspace.currentAlignmentId }, include: { occurrences: true, entries: { where: { archivedAt: null }, include: { translations: true } } },
  }) : null;
  const sentences = mapping.sentences.map((sentence, index) => ({ ...sentence, id: `sentence-${index}`, ...sentenceAudio[index] }));
  const alignment = await tx.textAlignment.create({ data: {
    textId: revision.textId, contentRevisionId: revision.id, narrationId, algorithmVersion: 2,
    status: mapping.status, sentences: sentences as unknown as Prisma.InputJsonValue,
    diagnostics: mapping.diagnostics as unknown as Prisma.InputJsonValue,
  } });
  await tx.wordOccurrence.createMany({ data: mapping.occurrences.map(word => ({
    alignmentId: alignment.id, ordinal: word.ordinal, sentenceId: `sentence-${word.sentenceIndex}`,
    charStart: word.charStart, charEnd: word.charEnd, surfaceText: word.surfaceText, normalizedText: word.normalizedText,
    speechStartSample: word.speechStartSample, speechEndSample: word.speechEndSample, mappingStatus: word.mappingStatus,
  })) });
  if (previous?.contentRevisionId === revision.id) {
    const words = await tx.wordOccurrence.findMany({ where: { alignmentId: alignment.id } });
    const byStart = new Map(words.map(word => [word.charStart, word]));
    const byEnd = new Map(words.map(word => [word.charEnd, word]));
    const oldWords = new Map(previous.occurrences.map(word => [word.id, word]));
    for (const entry of previous.entries) {
      const first = byStart.get(oldWords.get(entry.occurrenceId)?.charStart ?? -1);
      const last = byEnd.get(oldWords.get(entry.endOccurrenceId ?? entry.occurrenceId)?.charEnd ?? -1);
      if (!first || !last || first.sentenceId !== last.sentenceId) continue;
      await tx.textVocabularyEntry.create({ data: {
        textId: revision.textId, alignmentId: alignment.id, occurrenceId: first.id,
        endOccurrenceId: first.id === last.id ? null : last.id, selected: entry.selected, recordingId: entry.recordingId,
        translations: { create: entry.translations.map(t => ({ languageCode: t.languageCode, translation: t.translation, usageExample: t.usageExample })) },
      } });
    }
  }
  await tx.textWorkspace.updateMany({ where: { textId: revision.textId, currentContentRevisionId: revision.id }, data: { currentAlignmentId: alignment.id, approvedTextReleaseId: null } });
  return alignment;
}

export async function ensureTextMap(tx: Prisma.TransactionClient, textId: string) {
  const workspace = await tx.textWorkspace.findUniqueOrThrow({ where: { textId } });
  if (!workspace.currentContentRevisionId) return workspace;
  const alignment = workspace.currentAlignmentId ? await tx.textAlignment.findUnique({ where: { id: workspace.currentAlignmentId }, include: { _count: { select: { occurrences: true } } } }) : null;
  if (alignment?.contentRevisionId === workspace.currentContentRevisionId && alignment._count.occurrences) return workspace;
  const revision = await tx.textContentRevision.findUniqueOrThrow({ where: { id: workspace.currentContentRevisionId } });
  const ends = workspace.sentenceEndOffsets as number[] | null;
  await persistTextMap(tx, revision, mapSourceText(revision.text, splitSentences(revision.text, revision.sourceLanguage, ends ?? undefined)));
  return tx.textWorkspace.findUniqueOrThrow({ where: { textId } });
}

export async function saveSentencePlan(tx: Prisma.TransactionClient, revision: TextContentRevision, ends: number[]) {
  let spans: SentenceSpan[];
  try { spans = splitSentences(revision.text, revision.sourceLanguage, ends); }
  catch (error) { throw new ReaderReleaseError(422, (error as Error).message); }
  const workspace = await ensureTextMap(tx, revision.textId);
  const alignment = await tx.textAlignment.findUniqueOrThrow({ where: { id: workspace.currentAlignmentId! }, include: {
    occurrences: true, entries: { where: { selected: true, archivedAt: null } },
  } });
  for (const entry of alignment.entries) {
    const first = alignment.occurrences.find(word => word.id === entry.occurrenceId);
    const last = alignment.occurrences.find(word => word.id === (entry.endOccurrenceId ?? entry.occurrenceId));
    if (first && last && !spans.some(span => first.charStart >= span.charStart && last.charEnd <= span.charEnd))
      throw new ReaderReleaseError(422, 'A sentence break divides a selected learning phrase. Join those sentences or remove the phrase first.');
  }
  const previous = alignment.sentences as unknown as SentenceSpan[];
  const changed = JSON.stringify(previous.map(s => [s.charStart, s.charEnd])) !== JSON.stringify(spans.map(s => [s.charStart, s.charEnd]));
  if (changed) await persistTextMap(tx, revision, mapSourceText(revision.text, spans));
  await tx.textWorkspace.update({ where: { textId: revision.textId }, data: {
    sentenceEndOffsets: ends, ...(changed ? { currentNarrationId: null, approvedTextReleaseId: null, draftVersion: { increment: 1 } } : {}),
  } });
  return spans;
}
