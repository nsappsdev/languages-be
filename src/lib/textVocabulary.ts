import { PrismaClient } from '@prisma/client';
import { lockText } from './authoringTransaction';
import { TextWorkspaceError } from './textWorkspaces';
import { ReaderReleaseError } from './readerRelease';
import { assertNonOverlappingRanges, resolveVocabularyRange } from './vocabularyRanges';

/**
 * Text-local vocabulary: every entry is keyed by (alignmentId, occurrenceId),
 * never by spelling. The same word in two different texts (or even two
 * occurrences in the same text) keeps independent entries and translations.
 * Audio can reference a shared vocabulary recording.
 */

export interface SelectionChange {
  occurrenceId: string;
  endOccurrenceId?: string | null;
  selected: boolean;
}

export interface VocabularyImportEntry {
  occurrenceId: string;
  endOccurrenceId?: string | null;
  translation: string;
}

type VocabularyChange = SelectionChange & { translation?: string };

async function changeVocabulary(prisma: PrismaClient, params: {
  textId: string; alignmentId: string; expectedDraftVersion?: number; changes: VocabularyChange[];
}) {
  return prisma.$transaction(async tx => {
    await lockText(tx, params.textId);
    const workspace = await tx.textWorkspace.findUniqueOrThrow({ where: { textId: params.textId } });
    if (params.expectedDraftVersion !== undefined && workspace.draftVersion !== params.expectedDraftVersion)
      throw new ReaderReleaseError(409, 'This text changed after the preview. Refresh the preview and try again.');
    const alignment = await tx.textAlignment.findFirst({ where: { id: params.alignmentId, textId: params.textId } });
    if (!alignment || workspace.currentAlignmentId !== alignment.id || alignment.contentRevisionId !== workspace.currentContentRevisionId ||
        alignment.narrationId !== workspace.currentNarrationId) {
      if (params.expectedDraftVersion === undefined) throw new TextWorkspaceError('ALIGNMENT_NOT_FOUND', 'Alignment does not belong to this text');
      throw new ReaderReleaseError(409, 'Text alignment changed. Reload the text.');
    }
    if (params.changes.some(change => change.selected)) {
      const activeJob = await tx.audioJob.findFirst({ where: { textId: params.textId, kind: 'GENERATE_NARRATION', status: { in: ['QUEUED', 'RUNNING'] } } });
      if (alignment.status !== 'OK' || activeJob) throw new ReaderReleaseError(409, 'Wait for valid narration before selecting learning words.');
    }
    if (new Set(params.changes.map(change => change.occurrenceId)).size !== params.changes.length)
      throw new ReaderReleaseError(422, 'Each occurrence may appear only once in a batch.');
    const words = await tx.wordOccurrence.findMany({ where: { alignmentId: alignment.id }, orderBy: { ordinal: 'asc' } });
    const existing = await tx.textVocabularyEntry.findMany({ where: { textId: params.textId, alignmentId: alignment.id, archivedAt: null } });
    const selected = new Map(existing.filter(entry => entry.selected).map(entry => [entry.occurrenceId, {
      occurrenceId: entry.occurrenceId, endOccurrenceId: entry.endOccurrenceId,
    }]));
    for (const change of params.changes) {
      if (!words.some(word => word.id === change.occurrenceId)) throw new ReaderReleaseError(422, 'A word no longer belongs to this text.');
      if (change.selected) {
        const range = resolveVocabularyRange(words, change);
        selected.set(change.occurrenceId, { occurrenceId: change.occurrenceId, endOccurrenceId: range.last.id === range.first.id ? null : range.last.id });
      } else selected.delete(change.occurrenceId);
    }
    assertNonOverlappingRanges(words, [...selected.values()]);
    const entries = [];
    for (const change of params.changes) {
      const previous = existing.find(entry => entry.occurrenceId === change.occurrenceId);
      if (!previous && !change.selected) continue;
      const endOccurrenceId = change.selected ? selected.get(change.occurrenceId)!.endOccurrenceId : previous!.endOccurrenceId;
      const entry = await tx.textVocabularyEntry.upsert({
        where: { alignmentId_occurrenceId: { alignmentId: alignment.id, occurrenceId: change.occurrenceId } },
        create: { textId: params.textId, alignmentId: alignment.id, occurrenceId: change.occurrenceId, endOccurrenceId, selected: true },
        update: { selected: change.selected, endOccurrenceId, archivedAt: null },
      });
      // A different phrase is a different meaning. Never reuse a single word's translation accidentally.
      // Historical publications and their translations remain immutable.
      if (previous && previous.endOccurrenceId !== endOccurrenceId)
        await tx.textVocabularyTranslation.deleteMany({ where: { entryId: entry.id } });
      if (change.translation !== undefined) {
        await tx.textVocabularyTranslation.deleteMany({ where: { entryId: entry.id, languageCode: 'am' } });
        await tx.textVocabularyTranslation.upsert({ where: { entryId_languageCode: { entryId: entry.id, languageCode: 'hy' } },
          create: { entryId: entry.id, languageCode: 'hy', translation: change.translation.trim() },
          update: { translation: change.translation.trim() } });
      }
      entries.push(await tx.textVocabularyEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { translations: true } }));
    }
    await tx.textWorkspace.update({ where: { textId: params.textId }, data: { draftVersion: { increment: 1 }, approvedTextReleaseId: null } });
    return entries;
  }, { timeout: 60000 });
}

export async function setSelection(prisma: PrismaClient, params: { textId: string; alignmentId: string; changes: SelectionChange[] }) {
  return changeVocabulary(prisma, params);
}

/** One locked transaction: every imported selection and translation commits, or none do. */
export async function importVocabulary(prisma: PrismaClient, params: {
  textId: string; alignmentId: string; expectedDraftVersion: number; entries: VocabularyImportEntry[];
}) {
  return changeVocabulary(prisma, { ...params, changes: params.entries.map(entry => ({ ...entry, selected: true })) });
}

export interface TranslationInput {
  languageCode: string;
  translation: string;
  usageExample?: string;
}

/**
 * Full replacement of the translation set for exactly one entry. Never
 * touches any other text's or entry's translations.
 */
export async function setTranslations(
  prisma: PrismaClient,
  params: { entryId: string; textId: string; translations: TranslationInput[] },
) {
  return prisma.$transaction(async (tx) => {
    await lockText(tx, params.textId);
    const workspace = await tx.textWorkspace.update({ where: { textId: params.textId }, data: { draftVersion: { increment: 1 }, approvedTextReleaseId: null } });
    const entry = await tx.textVocabularyEntry.findFirst({ where: { id: params.entryId, textId: params.textId } });
    if (!entry || entry.archivedAt || entry.alignmentId !== workspace.currentAlignmentId) {
      throw new TextWorkspaceError('ENTRY_NOT_FOUND', 'Vocabulary entry does not belong to this text');
    }

    const languageCodes = params.translations.map((t) => t.languageCode === 'am' ? 'hy' : t.languageCode);
    if (new Set(languageCodes).size !== languageCodes.length) {
      throw new TextWorkspaceError('DUPLICATE_LANGUAGE', 'Each language may only appear once per entry');
    }

    await tx.textVocabularyTranslation.deleteMany({ where: { entryId: params.entryId } });
    if (params.translations.length) {
      await tx.textVocabularyTranslation.createMany({
        data: params.translations.map((t) => ({
          entryId: params.entryId,
          languageCode: t.languageCode === 'am' ? 'hy' : t.languageCode,
          translation: t.translation,
          usageExample: t.usageExample ?? null,
        })),
      });
    }

    return tx.textVocabularyEntry.findUnique({ where: { id: params.entryId }, include: { translations: true } });
  });
}
