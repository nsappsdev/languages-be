import { PrismaClient } from '@prisma/client';
import { TextWorkspaceError } from './textWorkspaces';

/**
 * Text-local vocabulary: every entry is keyed by (alignmentId, occurrenceId),
 * never by spelling. The same word in two different texts (or even two
 * occurrences in the same text) always gets independent entries, translations
 * and clips (plan §1 item 3, mission requirement 6/9).
 */

export interface SelectionChange {
  occurrenceId: string;
  selected: boolean;
}

export async function setSelection(
  prisma: PrismaClient,
  params: { textId: string; alignmentId: string; changes: SelectionChange[] },
) {
  return prisma.$transaction(async (tx) => {
    const alignment = await tx.textAlignment.findFirst({ where: { id: params.alignmentId, textId: params.textId } });
    if (!alignment) {
      throw new TextWorkspaceError('ALIGNMENT_NOT_FOUND', 'Alignment does not belong to this text');
    }

    const occurrenceIds = params.changes.map((change) => change.occurrenceId);
    const occurrences = await tx.wordOccurrence.findMany({
      where: { id: { in: occurrenceIds }, alignmentId: params.alignmentId },
    });
    if (occurrences.length !== new Set(occurrenceIds).size) {
      throw new TextWorkspaceError('OCCURRENCE_NOT_FOUND', 'One or more occurrence ids are invalid for this alignment');
    }

    const entries = [];
    for (const change of params.changes) {
      const existing = await tx.textVocabularyEntry.findUnique({
        where: { alignmentId_occurrenceId: { alignmentId: params.alignmentId, occurrenceId: change.occurrenceId } },
      });
      if (existing) {
        entries.push(
          await tx.textVocabularyEntry.update({
            where: { id: existing.id },
            data: { selected: change.selected, archivedAt: null },
            include: { translations: true },
          }),
        );
      } else if (change.selected) {
        entries.push(
          await tx.textVocabularyEntry.create({
            data: { textId: params.textId, alignmentId: params.alignmentId, occurrenceId: change.occurrenceId, selected: true },
            include: { translations: true },
          }),
        );
      }
      // Deselecting an occurrence with no existing entry is a no-op: there is
      // no translation/history to preserve.
    }
    return entries;
  });
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
    const entry = await tx.textVocabularyEntry.findFirst({ where: { id: params.entryId, textId: params.textId } });
    if (!entry) {
      throw new TextWorkspaceError('ENTRY_NOT_FOUND', 'Vocabulary entry does not belong to this text');
    }

    const languageCodes = params.translations.map((t) => t.languageCode);
    if (new Set(languageCodes).size !== languageCodes.length) {
      throw new TextWorkspaceError('DUPLICATE_LANGUAGE', 'Each language may only appear once per entry');
    }

    await tx.textVocabularyTranslation.deleteMany({ where: { entryId: params.entryId } });
    if (params.translations.length) {
      await tx.textVocabularyTranslation.createMany({
        data: params.translations.map((t) => ({
          entryId: params.entryId,
          languageCode: t.languageCode,
          translation: t.translation,
          usageExample: t.usageExample ?? null,
        })),
      });
    }

    return tx.textVocabularyEntry.findUnique({ where: { id: params.entryId }, include: { translations: true } });
  });
}
