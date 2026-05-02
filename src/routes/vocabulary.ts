import { Response, Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { canonicalizeVocabularyText } from '../lib/vocabularyIngestion';

const router = Router();

const requireAdmin = (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ message: 'Unauthorized' });
    return false;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ message: 'Forbidden' });
    return false;
  }
  return true;
};

const autoDetectKind = (text: string): 'WORD' | 'PHRASE' | 'SENTENCE' => {
  if (/[.!?]/.test(text)) return 'SENTENCE';
  if (text.trim().split(/\s+/).length === 1) return 'WORD';
  return 'PHRASE';
};

const baseEntrySchema = z.object({
  englishText: z.string().min(1),
  kind: z.enum(['WORD', 'PHRASE', 'SENTENCE']).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const translationSchema = z.object({
  languageCode: z.string().min(2),
  translation: z.string().min(1),
  usageExample: z.string().optional(),
});

const vocabularyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  kind: z.enum(['WORD', 'PHRASE', 'SENTENCE']).optional(),
  tag: z.string().trim().max(50).optional(),
});

const vocabularyLookupSchema = z.object({
  items: z.array(z.string().trim().min(1)).min(1).max(100),
});

const bulkImportRowSchema = z.object({
  englishText: z.string().trim().min(1),
  translation: z.string().trim().min(1),
  kind: z.enum(['WORD', 'PHRASE', 'SENTENCE']).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  usageExample: z.string().optional(),
});

const bulkImportSchema = z.object({
  targetLanguageCode: z.string().trim().min(2).max(10),
  rows: z.array(bulkImportRowSchema).min(1).max(1000),
});

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(1000),
});

router.get('/vocabulary', authenticate, async (req: AuthenticatedRequest, res) => {
  const parsedQuery = vocabularyQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({ message: 'Invalid query', issues: parsedQuery.error.flatten() });
  }

  const { page, pageSize, q, kind, tag } = parsedQuery.data;

  const conditions: any[] = [];
  if (q && q.length > 0) {
    conditions.push({
      OR: [
        { englishText: { contains: q, mode: 'insensitive' } },
        { notes: { contains: q, mode: 'insensitive' } },
        { translations: { some: { translation: { contains: q, mode: 'insensitive' } } } },
      ],
    });
  }
  if (kind) {
    conditions.push({ kind });
  }
  if (tag && tag.length > 0) {
    conditions.push({ tags: { has: tag } });
  }
  const where = conditions.length > 0 ? { AND: conditions } : {};

  const [entries, total] = await Promise.all([
    prisma.vocabularyEntry.findMany({
      where,
      orderBy: { englishText: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { translations: true },
    }),
    prisma.vocabularyEntry.count({ where }),
  ]);

  return res.json({
    entries,
    page,
    pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  });
});

router.get('/vocabulary/:id', authenticate, async (req: AuthenticatedRequest, res) => {
  const entry = await prisma.vocabularyEntry.findUnique({
    where: { id: req.params.id },
    include: { translations: true },
  });
  if (!entry) return res.status(404).json({ message: 'Vocabulary entry not found' });
  return res.json({ entry });
});

router.post('/vocabulary/lookup', authenticate, async (req: AuthenticatedRequest, res) => {
  const parsed = vocabularyLookupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const normalizedItems = Array.from(
    new Set(
      parsed.data.items
        .map((item) => canonicalizeVocabularyText(item))
        .filter((item) => item.length > 0),
    ),
  );

  if (!normalizedItems.length) {
    return res.status(400).json({ message: 'No valid vocabulary lookup terms found' });
  }

  const entries = await prisma.vocabularyEntry.findMany({
    where: {
      OR: normalizedItems.map((item) => ({
        englishText: {
          equals: item,
          mode: 'insensitive',
        },
      })),
    },
    include: {
      translations: true,
    },
  });

  const entriesByText = new Map(entries.map((entry) => [entry.englishText.toLowerCase(), entry]));
  const orderedEntries = normalizedItems
    .map((item) => entriesByText.get(item.toLowerCase()))
    .filter((entry): entry is (typeof entries)[number] => Boolean(entry));

  return res.json({
    entries: orderedEntries,
    resolved: orderedEntries.length,
    requested: parsed.data.items.length,
  });
});

router.post('/vocabulary/bulk-import', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;

  const parsed = bulkImportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const { targetLanguageCode, rows } = parsed.data;
  const result = {
    created: 0,
    mergedTranslations: 0,
    skipped: 0,
    errors: [] as Array<{ row: number; message: string }>,
  };

  try {
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          const englishText = canonicalizeVocabularyText(row.englishText);
          if (!englishText) {
            result.errors.push({ row: i, message: 'englishText empty after canonicalization' });
            continue;
          }

          const kind = row.kind ?? autoDetectKind(englishText);

          const existing = await tx.vocabularyEntry.findFirst({
            where: { englishText: { equals: englishText, mode: 'insensitive' } },
            include: { translations: true },
          });

          if (!existing) {
            await tx.vocabularyEntry.create({
              data: {
                englishText,
                kind,
                notes: row.notes,
                tags: row.tags ?? [],
                createdById: req.user?.id,
                translations: {
                  create: [
                    {
                      languageCode: targetLanguageCode,
                      translation: row.translation,
                      usageExample: row.usageExample,
                    },
                  ],
                },
              },
            });
            result.created++;
          } else {
            const hasTranslation = existing.translations.some(
              (t) => t.languageCode.toLowerCase() === targetLanguageCode.toLowerCase(),
            );
            if (hasTranslation) {
              result.skipped++;
            } else {
              await tx.vocabularyTranslation.create({
                data: {
                  entryId: existing.id,
                  languageCode: targetLanguageCode,
                  translation: row.translation,
                  usageExample: row.usageExample,
                },
              });
              result.mergedTranslations++;
            }
          }
        } catch (rowErr) {
          result.errors.push({
            row: i,
            message: rowErr instanceof Error ? rowErr.message : 'Unknown error',
          });
        }
      }
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      message: err instanceof Error ? err.message : 'Bulk import failed',
    });
  }
});

router.post('/vocabulary/bulk-delete', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;

  const parsed = bulkDeleteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  try {
    const result = await prisma.vocabularyEntry.deleteMany({
      where: { id: { in: parsed.data.ids } },
    });
    return res.json({ deleted: result.count });
  } catch (err) {
    return res.status(500).json({
      message: err instanceof Error ? err.message : 'Bulk delete failed',
    });
  }
});

router.delete('/vocabulary/all', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await prisma.vocabularyEntry.deleteMany({});
    return res.json({ deleted: result.count });
  } catch (err) {
    return res.status(500).json({
      message: err instanceof Error ? err.message : 'Delete-all failed',
    });
  }
});

router.post('/vocabulary', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;

  const parsed = baseEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const translations = Array.isArray(req.body.translations)
    ? z.array(translationSchema).safeParse(req.body.translations)
    : null;

  if (translations && !translations.success) {
    return res.status(400).json({ message: 'Invalid translations', issues: translations.error.flatten() });
  }

  const englishText = canonicalizeVocabularyText(parsed.data.englishText);
  const duplicate = await prisma.vocabularyEntry.findFirst({
    where: { englishText: { equals: englishText, mode: 'insensitive' } },
  });
  if (duplicate) {
    return res.status(409).json({ message: 'Vocabulary entry already exists' });
  }

  const created = await prisma.vocabularyEntry.create({
    data: {
      englishText,
      kind: parsed.data.kind ?? 'WORD',
      notes: parsed.data.notes,
      tags: parsed.data.tags ?? [],
      createdById: req.user?.id,
      translations: translations?.data
        ? { create: translations.data.map((t) => ({ ...t })) }
        : undefined,
    },
    include: { translations: true },
  });

  return res.status(201).json({ entry: created });
});

router.patch('/vocabulary/:id', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;

  const parsed = baseEntrySchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const existing = await prisma.vocabularyEntry.findUnique({
    where: { id: req.params.id },
    include: { translations: true },
  });
  if (!existing) return res.status(404).json({ message: 'Vocabulary entry not found' });

  const nextEnglishText =
    parsed.data.englishText !== undefined
      ? canonicalizeVocabularyText(parsed.data.englishText)
      : existing.englishText;

  if (nextEnglishText !== existing.englishText) {
    const duplicate = await prisma.vocabularyEntry.findFirst({
      where: {
        id: { not: existing.id },
        englishText: { equals: nextEnglishText, mode: 'insensitive' },
      },
    });
    if (duplicate) {
      return res.status(409).json({ message: 'Vocabulary entry already exists' });
    }
  }

  const updated = await prisma.vocabularyEntry.update({
    where: { id: req.params.id },
    data: {
      englishText: nextEnglishText,
      notes: parsed.data.notes ?? existing.notes,
      tags: parsed.data.tags ?? existing.tags,
      kind: parsed.data.kind ?? existing.kind,
    },
    include: { translations: true },
  });

  return res.json({ entry: updated });
});

router.delete('/vocabulary/:id', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    await prisma.vocabularyEntry.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch (error) {
    return res.status(404).json({ message: 'Vocabulary entry not found' });
  }
});

router.post(
  '/vocabulary/:id/translations',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;

    const parsed = translationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const entry = await prisma.vocabularyEntry.findUnique({ where: { id: req.params.id } });
    if (!entry) {
      return res.status(404).json({ message: 'Vocabulary entry not found' });
    }

    const translation = await prisma.vocabularyTranslation.create({
      data: {
        entryId: entry.id,
        languageCode: parsed.data.languageCode,
        translation: parsed.data.translation,
        usageExample: parsed.data.usageExample,
      },
    });

    return res.status(201).json({ translation });
  },
);

router.patch(
  '/vocabulary/:entryId/translations/:translationId',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;

    const parsed = translationSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const translation = await prisma.vocabularyTranslation.findFirst({
      where: { id: req.params.translationId, entryId: req.params.entryId },
    });
    if (!translation) {
      return res.status(404).json({ message: 'Translation not found' });
    }

    const updated = await prisma.vocabularyTranslation.update({
      where: { id: translation.id },
      data: {
        languageCode: parsed.data.languageCode ?? translation.languageCode,
        translation: parsed.data.translation ?? translation.translation,
        usageExample: parsed.data.usageExample ?? translation.usageExample,
      },
    });

    return res.json({ translation: updated });
  },
);

router.delete(
  '/vocabulary/:entryId/translations/:translationId',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;

    const translation = await prisma.vocabularyTranslation.findFirst({
      where: { id: req.params.translationId, entryId: req.params.entryId },
    });
    if (!translation) {
      return res.status(404).json({ message: 'Translation not found' });
    }
    await prisma.vocabularyTranslation.delete({ where: { id: translation.id } });
    return res.status(204).send();
  },
);

export { router as vocabularyRouter };
