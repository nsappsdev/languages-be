import { Prisma, PrismaClient, VocabularyKind } from '@prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

const ARMENIAN_LANGUAGE_CODES = new Set(['am', 'hy']);
const TOKEN_PATTERN = /[A-Za-z0-9]+(?:[’'][A-Za-z0-9]+)?/g;

export type LessonVocabularyEntryWithTranslations = Prisma.LessonVocabularyEntryGetPayload<{
  include: { translations: true };
}>;

export interface LessonVocabularyCoverageItem {
  text: string;
  normalizedText: string;
  kind: VocabularyKind;
  entryId: string | null;
  hasTranslation: boolean;
  hasArmenianTranslation: boolean;
  translations: LessonVocabularyEntryWithTranslations['translations'];
  matched: boolean;
  matchCount: number;
}

type TextToken = {
  normalized: string;
  start: number;
  end: number;
  text: string;
};

export type LessonVocabularySourceItem = {
  id?: string | null;
  text: string;
  wordTimings?: Array<{
    text: string;
    normalizedText?: string | null;
  }>;
};

export interface AutoCreateLessonVocabularyResult {
  candidates: number;
  created: number;
  skipped: number;
}

export function canonicalizeVocabularyText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((part) => part.replace(/(^'+|'+$)/g, '').replace(/'s$/g, ''))
    .filter(Boolean)
    .join(' ');
}

export function autoDetectVocabularyKind(text: string): VocabularyKind {
  const normalized = canonicalizeVocabularyText(text);
  if (/[.!?]/.test(text)) return 'SENTENCE';
  return normalized.split(/\s+/).filter(Boolean).length > 1 ? 'PHRASE' : 'WORD';
}

export function tokenizeVocabularyText(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  for (const match of text.replace(/[’]/g, "'").matchAll(TOKEN_PATTERN)) {
    const raw = match[0];
    const normalized = canonicalizeVocabularyText(raw);
    if (!normalized) continue;
    tokens.push({
      normalized,
      start: match.index ?? 0,
      end: (match.index ?? 0) + raw.length,
      text: raw,
    });
  }
  return tokens;
}

export function extractLessonVocabularyCandidates(items: LessonVocabularySourceItem[]) {
  const candidates = new Map<
    string,
    {
      englishText: string;
      kind: VocabularyKind;
      sourceItemId: string | null;
    }
  >();
  const addCandidate = (englishText: string, sourceItemId: string | null) => {
    const normalizedText = canonicalizeVocabularyText(englishText);
    if (!normalizedText || candidates.has(normalizedText)) return;
    candidates.set(normalizedText, {
      englishText: englishText.trim(),
      kind: autoDetectVocabularyKind(englishText),
      sourceItemId,
    });
  };

  for (const item of items) {
    const sourceItemId = item.id ?? null;

    for (const mark of item.wordTimings ?? []) {
      const text = mark.text || mark.normalizedText || '';
      addCandidate(text, sourceItemId);
    }

    for (const token of tokenizeVocabularyText(item.text)) {
      addCandidate(token.normalized, sourceItemId);
    }
  }

  return candidates;
}

export async function ensureLessonVocabularyEntriesForItems(
  db: DbClient,
  lessonId: string,
  items: LessonVocabularySourceItem[],
): Promise<AutoCreateLessonVocabularyResult> {
  const candidates = extractLessonVocabularyCandidates(items);
  if (!candidates.size) {
    return { candidates: 0, created: 0, skipped: 0 };
  }

  const existing = await db.lessonVocabularyEntry.findMany({
    where: { lessonId },
    select: { normalizedText: true, order: true },
  });
  const existingNormalized = new Set(existing.map((entry) => entry.normalizedText));
  let nextOrder = existing.reduce((max, entry) => Math.max(max, entry.order), -1) + 1;
  let created = 0;

  for (const [normalizedText, candidate] of candidates) {
    if (existingNormalized.has(normalizedText)) continue;

    await db.lessonVocabularyEntry.create({
      data: {
        lessonId,
        sourceItemId: candidate.sourceItemId,
        englishText: candidate.englishText,
        normalizedText,
        kind: candidate.kind,
        order: nextOrder,
        tags: [],
      },
    });
    existingNormalized.add(normalizedText);
    nextOrder += 1;
    created += 1;
  }

  return {
    candidates: candidates.size,
    created,
    skipped: candidates.size - created,
  };
}

export async function getLessonVocabulary(db: DbClient, lessonId: string) {
  return db.lessonVocabularyEntry.findMany({
    where: { lessonId },
    orderBy: [{ order: 'asc' }, { englishText: 'asc' }],
    include: { translations: true },
  });
}

export async function getNextLessonVocabularyOrder(db: DbClient, lessonId: string) {
  const last = await db.lessonVocabularyEntry.findFirst({
    where: { lessonId },
    orderBy: { order: 'desc' },
    select: { order: true },
  });
  return (last?.order ?? -1) + 1;
}

export async function buildLessonVocabularyPayload(
  db: DbClient,
  lessonId: string,
  texts?: string[],
) {
  const [entries, lessonItems] = await Promise.all([
    getLessonVocabulary(db, lessonId),
    texts
      ? Promise.resolve(null)
      : db.lessonItem.findMany({
          where: { lessonId },
          orderBy: { order: 'asc' },
          select: { text: true },
        }),
  ]);
  const lessonTexts = texts ?? lessonItems?.map((item) => item.text) ?? [];
  const coverage = buildLessonVocabularyCoverage(entries, lessonTexts);

  return {
    coverage,
    vocabulary: entries.map(sortEntryTranslations),
  };
}

export function buildLessonVocabularyCoverage(
  entries: LessonVocabularyEntryWithTranslations[],
  texts: string[],
): LessonVocabularyCoverageItem[] {
  const matchCounts = countEntryMatches(entries, texts);

  return entries.map((entry) => {
    const translations = sortTranslations(entry.translations);
    const matchCount = matchCounts.get(entry.id) ?? 0;
    return {
      text: entry.englishText,
      normalizedText: entry.normalizedText,
      kind: entry.kind,
      entryId: entry.id,
      hasTranslation: translations.length > 0,
      hasArmenianTranslation: translations.some((translation) =>
        ARMENIAN_LANGUAGE_CODES.has(translation.languageCode.toLowerCase()),
      ),
      translations,
      matched: matchCount > 0,
      matchCount,
    };
  });
}

function countEntryMatches(entries: LessonVocabularyEntryWithTranslations[], texts: string[]) {
  const counts = new Map<string, number>();
  const matchableEntries = entries
    .map((entry) => ({
      entry,
      parts: entry.normalizedText.split(/\s+/).filter(Boolean),
    }))
    .filter((item) => item.parts.length > 0)
    .sort((left, right) => right.parts.length - left.parts.length);

  for (const text of texts) {
    const tokens = tokenizeVocabularyText(text);
    const occupied = new Set<number>();

    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
      if (occupied.has(tokenIndex)) continue;

      for (const candidate of matchableEntries) {
        const { parts } = candidate;
        if (tokenIndex + parts.length > tokens.length) continue;
        if (parts.some((part, offset) => tokens[tokenIndex + offset]?.normalized !== part)) {
          continue;
        }

        for (let offset = 0; offset < parts.length; offset += 1) {
          occupied.add(tokenIndex + offset);
        }
        counts.set(candidate.entry.id, (counts.get(candidate.entry.id) ?? 0) + 1);
        break;
      }
    }
  }

  return counts;
}

export function sortEntryTranslations<T extends LessonVocabularyEntryWithTranslations>(entry: T): T {
  return {
    ...entry,
    translations: sortTranslations(entry.translations),
  };
}

export function sortTranslations<T extends { languageCode: string }>(translations: T[]) {
  return [...translations].sort((left, right) => {
    if (left.languageCode === 'am' && right.languageCode !== 'am') return -1;
    if (left.languageCode !== 'am' && right.languageCode === 'am') return 1;
    if (left.languageCode === 'hy' && right.languageCode !== 'hy') return -1;
    if (left.languageCode !== 'hy' && right.languageCode === 'hy') return 1;
    return left.languageCode.localeCompare(right.languageCode);
  });
}
