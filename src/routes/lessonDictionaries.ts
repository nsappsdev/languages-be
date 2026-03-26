import { Response, Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';

const router = Router();

const learnerDictionaryStatusSchema = z.object({
  status: z.enum(['NEW', 'LEARNING', 'LEARNED']),
});

const adminDictionaryEntrySchema = z.object({
  entryId: z.string().trim().min(1),
  order: z.number().int().nonnegative().optional(),
  sourceItemId: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional(),
});

const adminDictionaryReplaceSchema = z.object({
  entries: z.array(adminDictionaryEntrySchema).max(200),
});

const adminDictionaryEntryInclude = {
  entry: {
    include: {
      translations: true,
    },
  },
} as const;

const learnerDictionaryEntryInclude = {
  entry: {
    include: {
      translations: true,
    },
  },
  learnerStatuses: true,
} as const;

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

function normalizeDictionaryEntries<T extends { order: number; entry: { translations: Array<{ languageCode: string }> } }>(
  entries: T[],
) {
  return entries
    .sort((left, right) => left.order - right.order)
    .map((entry) => ({
      ...entry,
      entry: {
        ...entry.entry,
        translations: sortTranslations(entry.entry.translations),
      },
    }));
}

function sortTranslations<T extends { languageCode: string }>(translations: T[]) {
  return [...translations].sort((left, right) => {
    if (left.languageCode === 'am' && right.languageCode !== 'am') return -1;
    if (left.languageCode !== 'am' && right.languageCode === 'am') return 1;
    return left.languageCode.localeCompare(right.languageCode);
  });
}

async function validateLessonDictionaryPayload(
  lessonId: string,
  entries: Array<z.infer<typeof adminDictionaryEntrySchema>>,
) {
  const lesson = await prisma.lesson.findUnique({
    where: { id: lessonId },
    include: { items: true },
  });

  if (!lesson) {
    return { ok: false as const, status: 404, body: { message: 'Lesson not found' } };
  }

  const entryIds = Array.from(new Set(entries.map((entry) => entry.entryId)));
  if (entryIds.length !== entries.length) {
    return {
      ok: false as const,
      status: 400,
      body: { message: 'Duplicate vocabulary entries are not allowed inside one lesson dictionary' },
    };
  }

  const vocabularyEntries = await prisma.vocabularyEntry.findMany({
    where: { id: { in: entryIds } },
    select: { id: true },
  });

  if (vocabularyEntries.length !== entryIds.length) {
    return {
      ok: false as const,
      status: 400,
      body: { message: 'One or more vocabulary entries do not exist' },
    };
  }

  const validItemIds = new Set(lesson.items.map((item) => item.id));
  for (const entry of entries) {
    if (entry.sourceItemId && !validItemIds.has(entry.sourceItemId)) {
      return {
        ok: false as const,
        status: 400,
        body: { message: `Lesson item "${entry.sourceItemId}" does not belong to this lesson` },
      };
    }
  }

  const resolvedOrders = entries.map((entry, index) => entry.order ?? index);
  if (new Set(resolvedOrders).size !== resolvedOrders.length) {
    return {
      ok: false as const,
      status: 400,
      body: { message: 'Lesson dictionary entry orders must be unique' },
    };
  }

  return { ok: true as const, lesson };
}

async function getAdminLessonDictionary(lessonId: string) {
  const lesson = await prisma.lesson.findUnique({
    where: { id: lessonId },
    select: {
      id: true,
      title: true,
      status: true,
      dictionaryEntries: {
        orderBy: { order: 'asc' },
        include: adminDictionaryEntryInclude,
      },
    },
  });

  if (!lesson) {
    return null;
  }

  return {
    ...lesson,
    dictionaryEntries: normalizeDictionaryEntries(lesson.dictionaryEntries),
  };
}

router.get('/lessons/:lessonId/dictionary', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;

  const lesson = await getAdminLessonDictionary(req.params.lessonId);
  if (!lesson) {
    return res.status(404).json({ message: 'Lesson not found' });
  }

  return res.json({ lesson });
});

router.put('/lessons/:lessonId/dictionary', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;

  const parsed = adminDictionaryReplaceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const validation = await validateLessonDictionaryPayload(req.params.lessonId, parsed.data.entries);
  if (!validation.ok) {
    return res.status(validation.status).json(validation.body);
  }

  await prisma.$transaction(async (tx) => {
    await tx.lessonDictionaryEntry.deleteMany({
      where: { lessonId: req.params.lessonId },
    });

    if (!parsed.data.entries.length) {
      return;
    }

    await tx.lessonDictionaryEntry.createMany({
      data: parsed.data.entries.map((entry, index) => ({
        lessonId: req.params.lessonId,
        entryId: entry.entryId,
        order: entry.order ?? index,
        sourceItemId: entry.sourceItemId,
        notes: entry.notes,
      })),
    });
  });

  const lesson = await getAdminLessonDictionary(req.params.lessonId);
  return res.json({ lesson });
});

router.post('/lessons/:lessonId/dictionary', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;

  const parsed = adminDictionaryEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const validation = await validateLessonDictionaryPayload(req.params.lessonId, [parsed.data]);
  if (!validation.ok) {
    return res.status(validation.status).json(validation.body);
  }

  const existingCount = await prisma.lessonDictionaryEntry.count({
    where: { lessonId: req.params.lessonId },
  });

  const targetOrder = parsed.data.order ?? existingCount;
  const conflictingOrder = await prisma.lessonDictionaryEntry.findFirst({
    where: {
      lessonId: req.params.lessonId,
      order: targetOrder,
    },
    select: { id: true },
  });

  if (conflictingOrder) {
    return res.status(400).json({ message: 'Lesson dictionary order already exists' });
  }

  try {
    const dictionaryEntry = await prisma.lessonDictionaryEntry.create({
      data: {
        lessonId: req.params.lessonId,
        entryId: parsed.data.entryId,
        order: targetOrder,
        sourceItemId: parsed.data.sourceItemId,
        notes: parsed.data.notes,
      },
      include: adminDictionaryEntryInclude,
    });

    return res.status(201).json({
      dictionaryEntry: {
        ...dictionaryEntry,
        entry: {
          ...dictionaryEntry.entry,
          translations: sortTranslations(dictionaryEntry.entry.translations),
        },
      },
    });
  } catch (error) {
    return res.status(409).json({ message: 'This vocabulary entry is already linked to the lesson' });
  }
});

router.delete(
  '/lessons/:lessonId/dictionary/:dictionaryEntryId',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;

    const entry = await prisma.lessonDictionaryEntry.findFirst({
      where: {
        id: req.params.dictionaryEntryId,
        lessonId: req.params.lessonId,
      },
      select: { id: true },
    });

    if (!entry) {
      return res.status(404).json({ message: 'Lesson dictionary entry not found' });
    }

    await prisma.lessonDictionaryEntry.delete({
      where: { id: entry.id },
    });

    return res.status(204).send();
  },
);

router.get('/me/dictionaries', authenticate, async (req: AuthenticatedRequest, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const lessons = await prisma.lesson.findMany({
    where: {
      status: 'PUBLISHED',
      dictionaryEntries: {
        some: {},
      },
    },
    orderBy: { updatedAt: 'desc' },
    include: {
      dictionaryEntries: {
        include: {
          learnerStatuses: {
            where: { userId: user.id },
            select: {
              status: true,
            },
          },
        },
      },
    },
  });

  const dictionaries = lessons.map((lesson) => {
    let newEntries = 0;
    let learningEntries = 0;
    let learnedEntries = 0;

    for (const entry of lesson.dictionaryEntries) {
      const status = entry.learnerStatuses[0]?.status ?? 'NEW';
      if (status === 'LEARNED') {
        learnedEntries += 1;
      } else if (status === 'LEARNING') {
        learningEntries += 1;
      } else {
        newEntries += 1;
      }
    }

    return {
      lessonId: lesson.id,
      title: lesson.title,
      description: lesson.description,
      status: lesson.status,
      totalEntries: lesson.dictionaryEntries.length,
      newEntries,
      learningEntries,
      learnedEntries,
    };
  });

  return res.json({ dictionaries });
});

router.get('/me/dictionaries/:lessonId', authenticate, async (req: AuthenticatedRequest, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const lesson = await prisma.lesson.findFirst({
    where: {
      id: req.params.lessonId,
      status: 'PUBLISHED',
    },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      dictionaryEntries: {
        orderBy: { order: 'asc' },
        include: {
          ...learnerDictionaryEntryInclude,
          learnerStatuses: {
            where: { userId: user.id },
          },
        },
      },
    },
  });

  if (!lesson) {
    return res.status(404).json({ message: 'Lesson dictionary not found' });
  }

  const globalVocabulary = await prisma.learnerVocabulary.findMany({
    where: {
      userId: user.id,
      entryId: {
        in: lesson.dictionaryEntries.map((entry) => entry.entryId),
      },
    },
    select: {
      entryId: true,
      status: true,
      addedAt: true,
    },
  });

  const globalByEntryId = new Map(globalVocabulary.map((item) => [item.entryId, item]));

  const entries = normalizeDictionaryEntries(lesson.dictionaryEntries).map((entry) => {
    const learnerStatus = entry.learnerStatuses[0];
    const globalStatus = globalByEntryId.get(entry.entryId);

    return {
      id: entry.id,
      lessonId: lesson.id,
      entryId: entry.entryId,
      order: entry.order,
      sourceItemId: entry.sourceItemId,
      notes: entry.notes,
      status: learnerStatus?.status ?? 'NEW',
      rightSwipes: learnerStatus?.rightSwipes ?? 0,
      leftSwipes: learnerStatus?.leftSwipes ?? 0,
      lastReviewedAt: learnerStatus?.lastReviewedAt ?? null,
      firstSeenAt: learnerStatus?.firstSeenAt ?? null,
      globalVocabulary: globalStatus
        ? {
            status: globalStatus.status,
            addedAt: globalStatus.addedAt,
          }
        : null,
      entry: entry.entry,
    };
  });

  return res.json({
    dictionary: {
      lessonId: lesson.id,
      title: lesson.title,
      description: lesson.description,
      status: lesson.status,
      entries,
    },
  });
});

router.patch(
  '/me/dictionaries/:lessonId/:entryId',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const parsed = learnerDictionaryStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const dictionaryEntry = await prisma.lessonDictionaryEntry.findFirst({
      where: {
        lessonId: req.params.lessonId,
        entryId: req.params.entryId,
        lesson: {
          status: 'PUBLISHED',
        },
      },
      select: {
        id: true,
        lessonId: true,
        entryId: true,
      },
    });

    if (!dictionaryEntry) {
      return res.status(404).json({ message: 'Lesson dictionary entry not found' });
    }

    const nextStatus = parsed.data.status;
    const updated = await prisma.learnerLessonDictionaryEntry.upsert({
      where: {
        userId_lessonId_entryId: {
          userId: user.id,
          lessonId: dictionaryEntry.lessonId,
          entryId: dictionaryEntry.entryId,
        },
      },
      update: {
        dictionaryEntryId: dictionaryEntry.id,
        status: nextStatus,
        rightSwipes: nextStatus === 'LEARNED' ? { increment: 1 } : undefined,
        leftSwipes: nextStatus === 'LEARNING' ? { increment: 1 } : undefined,
        lastReviewedAt: new Date(),
      },
      create: {
        userId: user.id,
        lessonId: dictionaryEntry.lessonId,
        entryId: dictionaryEntry.entryId,
        dictionaryEntryId: dictionaryEntry.id,
        status: nextStatus,
        rightSwipes: nextStatus === 'LEARNED' ? 1 : 0,
        leftSwipes: nextStatus === 'LEARNING' ? 1 : 0,
        lastReviewedAt: new Date(),
      },
      include: {
        entry: {
          include: {
            translations: true,
          },
        },
      },
    });

    return res.json({
      review: {
        lessonId: updated.lessonId,
        entryId: updated.entryId,
        status: updated.status,
        rightSwipes: updated.rightSwipes,
        leftSwipes: updated.leftSwipes,
        lastReviewedAt: updated.lastReviewedAt,
        firstSeenAt: updated.firstSeenAt,
        entry: {
          ...updated.entry,
          translations: sortTranslations(updated.entry.translations),
        },
      },
    });
  },
);

export { router as lessonDictionaryRouter };
