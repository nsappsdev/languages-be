import { Prisma } from '@prisma/client';
import { Response, Router } from 'express';
import { z } from 'zod';
import { translateVocabularyToArmenian } from '../lib/openaiTranslations';
import { prisma } from '../lib/prisma';
import { applyVocabularyReviewDecision } from '../lib/vocabularyReview';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import {
  autoDetectVocabularyKind,
  buildLessonVocabularyPayload,
  canonicalizeVocabularyText,
  createLessonVocabularyEntriesFromTimingMarks,
  getTimingMarkForVocabulary,
  getNextLessonVocabularyOrder,
  sortEntryTranslations,
} from '../lib/vocabularyIngestion';

const router = Router();

const translationSchema = z.object({
  languageCode: z.string().trim().min(2).max(10),
  translation: z.string().trim().min(1),
  usageExample: z.string().trim().optional(),
});

const entrySchema = z.object({
  englishText: z.string().trim().min(1),
  kind: z.enum(['WORD', 'PHRASE', 'SENTENCE']).optional(),
  sourceItemId: z.string().trim().min(1).optional().nullable(),
  order: z.number().int().nonnegative().optional(),
  notes: z.string().trim().optional().nullable(),
  focusText: z.string().trim().optional().nullable(),
  tags: z.array(z.string().trim().min(1)).optional(),
  translations: z.array(translationSchema).optional(),
});

const entryPatchSchema = entrySchema.partial();

const importRowSchema = z.object({
  englishText: z.string().trim().min(1),
  translation: z.string().trim().min(1),
  kind: z.enum(['WORD', 'PHRASE', 'SENTENCE']).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  usageExample: z.string().optional(),
});

const importSchema = z.object({
  targetLanguageCode: z.string().trim().min(2).max(10),
  rows: z.array(importRowSchema).min(1).max(1000),
});

const aiTranslationSchema = z.preprocess(
  (value) => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    }
    return value ?? {};
  },
  z.object({
    targetLanguageCode: z.string().trim().min(2).max(10).optional().default('am'),
    entryIds: z
      .array(z.string().trim().min(1))
      .max(200)
      .nullable()
      .optional()
      .transform((value) => value ?? undefined),
  }),
);

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).max(1000),
});

const ARMENIAN_LANGUAGE_CODES = new Set(['am', 'hy']);
const FOCUS_WORD_PATTERN = /[A-Za-z0-9]+(?:[’'][A-Za-z0-9]+)?/g;

const learnerStatusSchema = z.object({
  status: z.enum(['NEW', 'LEARNING', 'LEARNED']),
});

const vocabularyReviewDecisionSchema = z.object({
  decision: z.enum(['AGAIN', 'KNOW']),
  idempotencyKey: z.string().trim().min(8).max(200),
});

function requireAdmin(req: AuthenticatedRequest, res: Response) {
  if (!req.user) {
    res.status(401).json({ message: 'Unauthorized' });
    return false;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ message: 'Forbidden' });
    return false;
  }
  return true;
}

function requireUser(req: AuthenticatedRequest, res: Response) {
  if (!req.user) {
    res.status(401).json({ message: 'Unauthorized' });
    return null;
  }
  return req.user;
}

async function ensureLesson(lessonId: string, publishedOnly = false) {
  return prisma.lesson.findFirst({
    where: {
      id: lessonId,
      ...(publishedOnly ? { status: 'PUBLISHED' as const } : {}),
    },
    include: { items: { orderBy: { order: 'asc' } } },
  });
}

async function validateSourceItem(lessonId: string, sourceItemId?: string | null) {
  if (!sourceItemId) return true;
  const item = await prisma.lessonItem.findFirst({
    where: { id: sourceItemId, lessonId },
    select: { id: true },
  });
  return Boolean(item);
}

function getDefaultFocusText(englishText: string) {
  const words = [...englishText.matchAll(FOCUS_WORD_PATTERN)].map((match) => match[0]);
  return words[words.length - 1] ?? englishText.trim();
}

function resolveFocusText({
  englishText,
  existingFocusText,
  focusText,
}: {
  englishText: string;
  existingFocusText?: string | null;
  focusText?: string | null;
}) {
  const normalizedEntry = canonicalizeVocabularyText(englishText);
  const candidate =
    focusText === undefined
      ? existingFocusText?.trim() || getDefaultFocusText(englishText)
      : focusText?.trim() || getDefaultFocusText(englishText);
  const normalizedFocus = canonicalizeVocabularyText(candidate);

  if (!normalizedFocus || !normalizedEntry.split(/\s+/).includes(normalizedFocus)) {
    const fallbackText = getDefaultFocusText(englishText);
    return {
      focusText: fallbackText,
      focusNormalizedText: canonicalizeVocabularyText(fallbackText) || normalizedEntry,
    };
  }

  return {
    focusText: candidate,
    focusNormalizedText: normalizedFocus,
  };
}

router.get('/lessons/:lessonId/vocabulary', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;

  const lesson = await ensureLesson(req.params.lessonId);
  if (!lesson) return res.status(404).json({ message: 'Lesson not found' });

  const payload = await buildLessonVocabularyPayload(
    prisma,
    lesson.id,
    lesson.items.map((item) => item.text),
  );

  return res.json({
    lesson: {
      id: lesson.id,
      title: lesson.title,
      status: lesson.status,
      vocabulary: payload.vocabulary,
      vocabularyCoverage: payload.coverage,
    },
  });
});

router.post('/lessons/:lessonId/vocabulary', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;

  const parsed = entrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const lesson = await ensureLesson(req.params.lessonId);
  if (!lesson) return res.status(404).json({ message: 'Lesson not found' });
  if (!(await validateSourceItem(lesson.id, parsed.data.sourceItemId))) {
    return res.status(400).json({ message: 'sourceItemId does not belong to this lesson' });
  }

  const normalizedText = canonicalizeVocabularyText(parsed.data.englishText);
  if (!normalizedText) {
    return res.status(400).json({ message: 'English text is empty after normalization' });
  }

  const order = parsed.data.order ?? (await getNextLessonVocabularyOrder(prisma, lesson.id));

  try {
    const focus = resolveFocusText({
      englishText: parsed.data.englishText,
      focusText: parsed.data.focusText,
    });
    const entry = await prisma.lessonVocabularyEntry.create({
      data: {
        lessonId: lesson.id,
        sourceItemId: parsed.data.sourceItemId || null,
        englishText: parsed.data.englishText.trim(),
        normalizedText,
        focusText: focus.focusText,
        focusNormalizedText: focus.focusNormalizedText,
        kind: parsed.data.kind ?? autoDetectVocabularyKind(parsed.data.englishText),
        order,
        notes: parsed.data.notes || null,
        tags: parsed.data.tags ?? [],
        translations: parsed.data.translations?.length
          ? { create: parsed.data.translations }
          : undefined,
      },
      include: { translations: true },
    });
    return res.status(201).json({ entry: sortEntryTranslations(entry) });
  } catch (error) {
    return res.status(409).json({ message: 'Lesson vocabulary entry already exists or order conflicts' });
  }
});

router.post(
  '/lessons/:lessonId/vocabulary/bulk-delete',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;

    const parsed = bulkDeleteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const lesson = await ensureLesson(req.params.lessonId);
    if (!lesson) return res.status(404).json({ message: 'Lesson not found' });

    const deleted = await prisma.lessonVocabularyEntry.deleteMany({
      where: {
        lessonId: lesson.id,
        id: { in: parsed.data.ids },
      },
    });

    return res.json({ deleted: deleted.count });
  },
);

router.post(
  '/lessons/:lessonId/vocabulary/pull-from-timings',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;

    const lesson = await prisma.lesson.findUnique({
      where: { id: req.params.lessonId },
      include: { items: { orderBy: { order: 'asc' } } },
    });
    if (!lesson) return res.status(404).json({ message: 'Lesson not found' });

    const result = await createLessonVocabularyEntriesFromTimingMarks(
      prisma,
      lesson.id,
      lesson.items.map((item) => ({
        id: item.id,
        text: '',
        wordTimings: Array.isArray(item.wordTimings)
          ? item.wordTimings
              .map((mark) => getTimingMarkForVocabulary(mark))
              .filter((mark): mark is { text: string; normalizedText: string | null } => mark !== null)
          : [],
      })),
    );

    return res.json(result);
  },
);

router.patch(
  '/lessons/:lessonId/vocabulary/:entryId',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;

    const parsed = entryPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const existing = await prisma.lessonVocabularyEntry.findFirst({
      where: { id: req.params.entryId, lessonId: req.params.lessonId },
      include: { translations: true },
    });
    if (!existing) return res.status(404).json({ message: 'Lesson vocabulary entry not found' });
    if (!(await validateSourceItem(req.params.lessonId, parsed.data.sourceItemId))) {
      return res.status(400).json({ message: 'sourceItemId does not belong to this lesson' });
    }

    const englishText = parsed.data.englishText?.trim() ?? existing.englishText;
    const normalizedText =
      parsed.data.englishText !== undefined
        ? canonicalizeVocabularyText(parsed.data.englishText)
        : existing.normalizedText;
    if (!normalizedText) {
      return res.status(400).json({ message: 'English text is empty after normalization' });
    }

    try {
      const focus = resolveFocusText({
        englishText,
        existingFocusText: existing.focusText,
        focusText: parsed.data.focusText,
      });
      const updated = await prisma.$transaction(async (tx) => {
        const entry = await tx.lessonVocabularyEntry.update({
          where: { id: existing.id },
          data: {
            englishText,
            normalizedText,
            focusText: focus.focusText,
            focusNormalizedText: focus.focusNormalizedText,
            kind: parsed.data.kind ?? existing.kind,
            order: parsed.data.order ?? existing.order,
            sourceItemId:
              parsed.data.sourceItemId === undefined
                ? existing.sourceItemId
                : parsed.data.sourceItemId || null,
            notes:
              parsed.data.notes === undefined
                ? existing.notes
                : parsed.data.notes || null,
            tags: parsed.data.tags ?? existing.tags,
          },
        });

        if (parsed.data.translations) {
          await tx.lessonVocabularyTranslation.deleteMany({ where: { entryId: existing.id } });
          if (parsed.data.translations.length) {
            await tx.lessonVocabularyTranslation.createMany({
              data: parsed.data.translations.map((translation) => ({
                entryId: existing.id,
                languageCode: translation.languageCode,
                translation: translation.translation,
                usageExample: translation.usageExample,
              })),
            });
          }
        }

        return tx.lessonVocabularyEntry.findUniqueOrThrow({
          where: { id: entry.id },
          include: { translations: true },
        });
      });
      return res.json({ entry: sortEntryTranslations(updated) });
    } catch (error) {
      return res.status(409).json({ message: 'Lesson vocabulary entry already exists or order conflicts' });
    }
  },
);

router.delete(
  '/lessons/:lessonId/vocabulary/:entryId',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;

    const existing = await prisma.lessonVocabularyEntry.findFirst({
      where: { id: req.params.entryId, lessonId: req.params.lessonId },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ message: 'Lesson vocabulary entry not found' });

    await prisma.lessonVocabularyEntry.delete({ where: { id: existing.id } });
    return res.status(204).send();
  },
);

router.post(
  '/lessons/:lessonId/vocabulary/import',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;

    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const lesson = await ensureLesson(req.params.lessonId);
    if (!lesson) return res.status(404).json({ message: 'Lesson not found' });

    const result = {
      created: 0,
      mergedTranslations: 0,
      skipped: 0,
      errors: [] as Array<{ row: number; message: string }>,
    };

    await prisma.$transaction(async (tx) => {
      let nextOrder = await getNextLessonVocabularyOrder(tx, lesson.id);
      for (let index = 0; index < parsed.data.rows.length; index += 1) {
        const row = parsed.data.rows[index];
        const normalizedText = canonicalizeVocabularyText(row.englishText);
        if (!normalizedText) {
          result.errors.push({ row: index, message: 'englishText empty after normalization' });
          continue;
        }

        const existing = await tx.lessonVocabularyEntry.findUnique({
          where: {
            lessonId_normalizedText: {
              lessonId: lesson.id,
              normalizedText,
            },
          },
          include: { translations: true },
        });

        if (!existing) {
          await tx.lessonVocabularyEntry.create({
            data: {
              lessonId: lesson.id,
              englishText: row.englishText.trim(),
              normalizedText,
              kind: row.kind ?? autoDetectVocabularyKind(row.englishText),
              order: nextOrder,
              notes: row.notes?.trim() || null,
              tags: row.tags ?? [],
              translations: {
                create: {
                  languageCode: parsed.data.targetLanguageCode,
                  translation: row.translation,
                  usageExample: row.usageExample,
                },
              },
            },
          });
          nextOrder += 1;
          result.created += 1;
          continue;
        }

        const hasLanguage = existing.translations.some(
          (translation) =>
            translation.languageCode.toLowerCase() === parsed.data.targetLanguageCode.toLowerCase(),
        );
        if (hasLanguage) {
          result.skipped += 1;
          continue;
        }

        await tx.lessonVocabularyTranslation.create({
          data: {
            entryId: existing.id,
            languageCode: parsed.data.targetLanguageCode,
            translation: row.translation,
            usageExample: row.usageExample,
          },
        });
        result.mergedTranslations += 1;
      }
    });

    return res.json(result);
  },
);

router.post(
  '/lessons/:lessonId/vocabulary/ai-translations',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;

    const parsed = aiTranslationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const targetLanguageCode = parsed.data.targetLanguageCode.toLowerCase();
    if (!ARMENIAN_LANGUAGE_CODES.has(targetLanguageCode)) {
      return res.status(400).json({ message: 'AI translation currently supports Armenian only.' });
    }

    const lesson = await prisma.lesson.findFirst({
      where: { id: req.params.lessonId },
      include: {
        items: { orderBy: { order: 'asc' } },
        vocabularyEntries: {
          orderBy: { order: 'asc' },
          include: { translations: true },
        },
      },
    });
    if (!lesson) return res.status(404).json({ message: 'Lesson not found' });

    const selectedIds = parsed.data.entryIds ? new Set(parsed.data.entryIds) : null;
    const missingEntries = lesson.vocabularyEntries
      .filter((entry) => entry.kind !== 'SENTENCE')
      .filter((entry) => !selectedIds || selectedIds.has(entry.id))
      .filter(
        (entry) =>
          !entry.translations.some((translation) =>
            ARMENIAN_LANGUAGE_CODES.has(translation.languageCode.toLowerCase()),
          ),
      )
      .slice(0, 200);

    if (!missingEntries.length) {
      return res.json({ translated: 0, skipped: 0 });
    }

    try {
      const translations = await translateVocabularyToArmenian({
        lessonTitle: lesson.title,
        lessonText: lesson.items.map((item) => item.text).join('\n\n').slice(0, 12000),
        entries: missingEntries.map((entry) => ({
          id: entry.id,
          englishText: entry.englishText,
          kind: entry.kind,
        })),
      });

      const missingById = new Map(missingEntries.map((entry) => [entry.id, entry]));
      const result = {
        translated: 0,
        skipped: 0,
      };

      await prisma.$transaction(async (tx) => {
        for (const translation of translations) {
          const entry = missingById.get(translation.id);
          if (!entry) {
            result.skipped += 1;
            continue;
          }

          const existing = await tx.lessonVocabularyTranslation.findFirst({
            where: {
              entryId: entry.id,
              languageCode: { in: Array.from(ARMENIAN_LANGUAGE_CODES) },
            },
            select: { id: true },
          });
          if (existing) {
            result.skipped += 1;
            continue;
          }

          await tx.lessonVocabularyTranslation.create({
            data: {
              entryId: entry.id,
              languageCode: targetLanguageCode,
              translation: translation.translation,
            },
          });
          result.translated += 1;
        }
      });
      result.skipped = Math.max(0, missingEntries.length - result.translated);

      return res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate AI translations';
      const status = message.includes('OPENAI_API_KEY') ? 503 : 502;
      return res.status(status).json({ message });
    }
  },
);

router.get('/me/vocabulary/lessons', authenticate, async (req: AuthenticatedRequest, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const rows = await prisma.learnerLessonVocabularyEntry.findMany({
    where: {
      userId: user.id,
      status: { in: ['LEARNING', 'LEARNED'] },
      lesson: { status: 'PUBLISHED' },
      entry: {
        translations: {
          some: { languageCode: { in: ['am', 'hy'] } },
        },
      },
    },
    select: {
      status: true,
      lesson: {
        select: {
          id: true,
          title: true,
          description: true,
          createdAt: true,
        },
      },
    },
    orderBy: {
      lesson: {
        createdAt: 'asc',
      },
    },
  });

  const summaries = new Map<
    string,
    {
      lessonId: string;
      title: string;
      description: string | null;
      activeCount: number;
      learnedCount: number;
    }
  >();

  rows.forEach((row) => {
    const summary = summaries.get(row.lesson.id) ?? {
      lessonId: row.lesson.id,
      title: row.lesson.title,
      description: row.lesson.description,
      activeCount: 0,
      learnedCount: 0,
    };
    if (row.status === 'LEARNED') {
      summary.learnedCount += 1;
    } else {
      summary.activeCount += 1;
    }
    summaries.set(row.lesson.id, summary);
  });

  return res.json({ lessons: [...summaries.values()] });
});

router.get('/me/lessons/:lessonId/vocabulary', authenticate, async (req: AuthenticatedRequest, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const lesson = await prisma.lesson.findFirst({
    where: { id: req.params.lessonId, status: 'PUBLISHED' },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      vocabularyEntries: {
        orderBy: { order: 'asc' },
        include: {
          translations: true,
          learnerStatuses: { where: { userId: user.id } },
        },
      },
    },
  });

  if (!lesson) return res.status(404).json({ message: 'Lesson vocabulary not found' });

  return res.json({
    vocabulary: {
      lessonId: lesson.id,
      title: lesson.title,
      description: lesson.description,
      status: lesson.status,
      entries: lesson.vocabularyEntries.map((entry) => {
        const status = entry.learnerStatuses[0];
        return {
          id: entry.id,
          lessonId: lesson.id,
          entryId: entry.id,
          status: status?.status ?? 'NEW',
          correctStreak: status?.correctStreak ?? 0,
          rightSwipes: status?.rightSwipes ?? 0,
          leftSwipes: status?.leftSwipes ?? 0,
          lastReviewedAt: status?.lastReviewedAt ?? null,
          firstSeenAt: status?.firstSeenAt ?? null,
          entry: sortEntryTranslations(entry),
        };
      }),
    },
  });
});

router.post(
  '/me/lessons/:lessonId/vocabulary/:entryId/review',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const parsed = vocabularyReviewDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const replayExistingDecision = async () => {
      const existing = await prisma.learnerVocabularyReviewDecision.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: user.id,
            idempotencyKey: parsed.data.idempotencyKey,
          },
        },
      });
      if (!existing) return null;
      if (
        existing.lessonId !== req.params.lessonId ||
        existing.entryId !== req.params.entryId ||
        existing.decision !== parsed.data.decision
      ) {
        return { conflict: true as const };
      }
      const entry = await prisma.lessonVocabularyEntry.findUnique({
        where: { id: existing.entryId },
        include: { translations: true },
      });
      if (!entry) return null;
      return {
        conflict: false as const,
        review: {
          lessonId: existing.lessonId,
          entryId: existing.entryId,
          status: existing.resultingStatus,
          correctStreak: existing.resultingCorrectStreak,
          rightSwipes: existing.resultingRightSwipes,
          leftSwipes: existing.resultingLeftSwipes,
          lastReviewedAt: existing.reviewedAt,
          firstSeenAt: null,
          entry: sortEntryTranslations(entry),
        },
      };
    };

    const existingDecision = await replayExistingDecision();
    if (existingDecision?.conflict) {
      return res.status(409).json({ message: 'Idempotency key already belongs to another review' });
    }
    if (existingDecision) {
      return res.json({ review: existingDecision.review });
    }

    try {
      const review = await prisma.$transaction(async (tx) => {
        const entry = await tx.lessonVocabularyEntry.findFirst({
          where: {
            id: req.params.entryId,
            lessonId: req.params.lessonId,
            lesson: { status: 'PUBLISHED' },
          },
          include: {
            translations: true,
            learnerStatuses: { where: { userId: user.id } },
          },
        });
        if (!entry) return null;

        const current = entry.learnerStatuses[0];
        if (!current || current.status !== 'LEARNING') {
          return { inactive: true as const };
        }

        const next = applyVocabularyReviewDecision(current, parsed.data.decision);
        const reviewedAt = new Date();
        const updated = await tx.learnerLessonVocabularyEntry.update({
          where: { id: current.id },
          data: {
            status: next.status,
            correctStreak: next.correctStreak,
            rightSwipes: next.rightSwipes,
            leftSwipes: next.leftSwipes,
            lastReviewedAt: reviewedAt,
          },
        });

        await tx.learnerVocabularyReviewDecision.create({
          data: {
            userId: user.id,
            lessonId: entry.lessonId,
            entryId: entry.id,
            decision: parsed.data.decision,
            idempotencyKey: parsed.data.idempotencyKey,
            resultingStatus: updated.status,
            resultingCorrectStreak: updated.correctStreak,
            resultingRightSwipes: updated.rightSwipes,
            resultingLeftSwipes: updated.leftSwipes,
            reviewedAt,
          },
        });

        return {
          inactive: false as const,
          lessonId: updated.lessonId,
          entryId: updated.entryId,
          status: updated.status,
          correctStreak: updated.correctStreak,
          rightSwipes: updated.rightSwipes,
          leftSwipes: updated.leftSwipes,
          lastReviewedAt: updated.lastReviewedAt,
          firstSeenAt: updated.firstSeenAt,
          entry: sortEntryTranslations(entry),
        };
      });

      if (!review) {
        return res.status(404).json({ message: 'Lesson vocabulary entry not found' });
      }
      if (review.inactive) {
        return res.status(409).json({ message: 'Only active learning words can be reviewed' });
      }
      return res.json({ review });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await replayExistingDecision();
        if (replay?.conflict) {
          return res.status(409).json({ message: 'Idempotency key already belongs to another review' });
        }
        if (replay) {
          return res.json({ review: replay.review });
        }
      }
      throw error;
    }
  },
);

router.patch(
  '/me/lessons/:lessonId/vocabulary/:entryId',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const parsed = learnerStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const entry = await prisma.lessonVocabularyEntry.findFirst({
      where: {
        id: req.params.entryId,
        lessonId: req.params.lessonId,
        lesson: { status: 'PUBLISHED' },
      },
      include: { translations: true },
    });
    if (!entry) return res.status(404).json({ message: 'Lesson vocabulary entry not found' });

    const nextStatus = parsed.data.status;
    const updated = await prisma.learnerLessonVocabularyEntry.upsert({
      where: {
        userId_lessonId_entryId: {
          userId: user.id,
          lessonId: req.params.lessonId,
          entryId: entry.id,
        },
      },
      update: {
        status: nextStatus,
        correctStreak: nextStatus === 'LEARNED' ? 2 : 0,
        rightSwipes: nextStatus === 'LEARNED' ? { increment: 1 } : undefined,
        leftSwipes: nextStatus === 'LEARNING' ? { increment: 1 } : undefined,
        lastReviewedAt: new Date(),
      },
      create: {
        userId: user.id,
        lessonId: req.params.lessonId,
        entryId: entry.id,
        status: nextStatus,
        correctStreak: nextStatus === 'LEARNED' ? 2 : 0,
        rightSwipes: nextStatus === 'LEARNED' ? 1 : 0,
        leftSwipes: nextStatus === 'LEARNING' ? 1 : 0,
        lastReviewedAt: new Date(),
      },
    });

    return res.json({
      review: {
        lessonId: updated.lessonId,
        entryId: updated.entryId,
        status: updated.status,
        correctStreak: updated.correctStreak,
        rightSwipes: updated.rightSwipes,
        leftSwipes: updated.leftSwipes,
        lastReviewedAt: updated.lastReviewedAt,
        firstSeenAt: updated.firstSeenAt,
        entry: sortEntryTranslations(entry),
      },
    });
  },
);

export { router as lessonVocabularyRouter };
