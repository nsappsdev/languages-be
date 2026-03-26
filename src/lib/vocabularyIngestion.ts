import { Prisma, PrismaClient } from '@prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

const LESSON_WORD_PATTERN = /[A-Za-z]+(?:'[A-Za-z]+)?/g;

export const canonicalizeVocabularyText = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/(^'+|'+$)/g, '')
    .replace(/'s$/g, '');

export const extractLessonWords = (texts: string[]) => {
  const uniqueWords = new Set<string>();

  for (const text of texts) {
    const normalized = text.replace(/[“”]/g, '"').replace(/[’]/g, "'");
    const matches = normalized.match(LESSON_WORD_PATTERN) ?? [];

    for (const match of matches) {
      const word = canonicalizeVocabularyText(match);
      if (word.length >= 1) {
        uniqueWords.add(word);
      }
    }
  }

  return [...uniqueWords].sort((left, right) => left.localeCompare(right));
};

export async function ensureVocabularyEntriesForLessonTexts(
  db: DbClient,
  texts: string[],
  createdById?: string | null,
) {
  const candidateWords = extractLessonWords(texts);
  if (!candidateWords.length) {
    return { createdCount: 0, totalWords: 0 };
  }

  const existingEntries = await db.vocabularyEntry.findMany({
    select: { englishText: true },
  });

  const existingWords = new Set(
    existingEntries.map((entry) => canonicalizeVocabularyText(entry.englishText)),
  );

  const missingWords = candidateWords.filter((word) => !existingWords.has(word));

  if (missingWords.length) {
    await db.vocabularyEntry.createMany({
      data: missingWords.map((word) => ({
        englishText: word,
        kind: 'WORD',
        createdById: createdById ?? undefined,
      })),
    });
  }

  return {
    createdCount: missingWords.length,
    totalWords: candidateWords.length,
  };
}
