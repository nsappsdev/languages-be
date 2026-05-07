import { Prisma, PrismaClient } from '@prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

const LESSON_WORD_PATTERN = /[A-Za-z]+(?:'[A-Za-z]+)?/g;
const ARMENIAN_LANGUAGE_CODES = new Set(['am', 'hy']);

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

type VocabularyEntryWithTranslations = Awaited<
  ReturnType<DbClient['vocabularyEntry']['findMany']>
>[number] & {
  translations: Awaited<ReturnType<DbClient['vocabularyTranslation']['findMany']>>;
};

export interface LessonVocabularyCoverageItem {
  text: string;
  normalizedText: string;
  kind: 'WORD' | 'PHRASE' | 'SENTENCE';
  entryId: string | null;
  hasTranslation: boolean;
  hasArmenianTranslation: boolean;
  translations: VocabularyEntryWithTranslations['translations'];
}

export async function buildLessonVocabularyCoverage(
  db: DbClient,
  texts: string[],
  options: { createdById?: string | null; ensureMissing?: boolean } = {},
) {
  if (options.ensureMissing) {
    await ensureVocabularyEntriesForLessonTexts(db, texts, options.createdById);
  }

  const lessonWords = extractLessonWords(texts);
  const lessonWordSet = new Set(lessonWords);
  const allWordEntries = lessonWords.length
    ? await db.vocabularyEntry.findMany({
        where: { kind: 'WORD' },
        include: { translations: true },
      })
    : [];
  const wordEntries = allWordEntries.filter((entry) =>
    lessonWordSet.has(canonicalizeVocabularyText(entry.englishText)),
  );

  const entriesByText = new Map(
    wordEntries.map((entry) => [canonicalizeVocabularyText(entry.englishText), entry]),
  );

  const wordCoverage = lessonWords.map((word): LessonVocabularyCoverageItem => {
    const entry = entriesByText.get(word) ?? null;
    return toCoverageItem(word, word, 'WORD', entry);
  });

  const phraseEntries = await db.vocabularyEntry.findMany({
    where: {
      kind: { in: ['PHRASE', 'SENTENCE'] },
    },
    include: { translations: true },
  });
  const normalizedLessonText = normalizeForPhraseSearch(texts.join(' '));
  const matchingPhraseEntries = phraseEntries.filter((entry) => {
    const phrase = normalizeForPhraseSearch(entry.englishText);
    return phrase.length > 0 && normalizedLessonText.includes(phrase);
  });
  const phraseCoverage = matchingPhraseEntries.map((entry) =>
    toCoverageItem(
      entry.englishText,
      canonicalizeVocabularyText(entry.englishText),
      entry.kind,
      entry,
    ),
  );

  const dictionaryById = new Map<string, VocabularyEntryWithTranslations>();
  for (const entry of [...wordEntries, ...matchingPhraseEntries]) {
    dictionaryById.set(entry.id, entry);
  }

  return {
    coverage: [...wordCoverage, ...phraseCoverage],
    dictionary: [...dictionaryById.values()].sort((left, right) =>
      left.englishText.localeCompare(right.englishText),
    ),
  };
}

function toCoverageItem(
  text: string,
  normalizedText: string,
  kind: 'WORD' | 'PHRASE' | 'SENTENCE',
  entry: VocabularyEntryWithTranslations | null,
): LessonVocabularyCoverageItem {
  const translations = entry?.translations ?? [];
  return {
    text,
    normalizedText,
    kind,
    entryId: entry?.id ?? null,
    hasTranslation: translations.length > 0,
    hasArmenianTranslation: translations.some((translation) =>
      ARMENIAN_LANGUAGE_CODES.has(translation.languageCode.toLowerCase()),
    ),
    translations,
  };
}

function normalizeForPhraseSearch(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/\s+/g, ' ');
}
