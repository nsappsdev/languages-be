import { Response, Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';
import { resolveStoredAudioPath } from '../lib/audioStorage';
import {
  buildHeuristicLogicalChunkTimings,
  buildLogicalChunkTimings,
  generateLessonTimingsFromTranscript,
} from '../lib/lessonTimingAlignment';
import { transcribeAudioWithWordTimestamps } from '../lib/openaiTranscription';
import { suggestLogicalTimingChunks } from '../lib/openaiTimingChunks';
import {
  buildLessonVocabularyPayload,
  canonicalizeVocabularyText,
} from '../lib/vocabularyIngestion';

const router = Router();

const lessonBaseSchema = z.object({
  title: z.string().min(2),
  description: z.string().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
});

const audioUrlSchema = z
  .string()
  .trim()
  .refine((value) => value.length === 0 || value.startsWith('/') || /^https?:\/\//i.test(value), {
    message: 'audioUrl must be empty, an absolute URL, or a root-relative media path',
  });

const segmentSchema = z
  .object({
    id: z.string().min(1).optional(),
    text: z.string().min(1),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
  })
  .refine((segment) => segment.endMs > segment.startMs, {
    message: 'Segment endMs must be greater than startMs',
    path: ['endMs'],
  });

const wordTimingSchema = z
  .object({
    id: z.string().min(1).optional(),
    text: z.string().trim().min(1),
    normalizedText: z.string().trim().min(1).optional(),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
    order: z.number().int().nonnegative().optional(),
  })
  .refine((mark) => mark.endMs > mark.startMs, {
    message: 'Word timing endMs must be greater than startMs',
    path: ['endMs'],
  });

const sentenceTimingSchema = z
  .object({
    id: z.string().min(1).optional(),
    text: z.string().trim().min(1),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
    wordMarkIds: z.array(z.string().min(1)).default([]),
    order: z.number().int().nonnegative().optional(),
  })
  .refine((mark) => mark.endMs > mark.startMs, {
    message: 'Sentence timing endMs must be greater than startMs',
    path: ['endMs'],
  });

const chunkTimingSchema = z
  .object({
    id: z.string().min(1).optional(),
    text: z.string().trim().min(1),
    normalizedText: z.string().trim().min(1).optional(),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
    wordMarkIds: z.array(z.string().min(1)).default([]),
    order: z.number().int().nonnegative().optional(),
  })
  .refine((mark) => mark.endMs > mark.startMs, {
    message: 'Chunk timing endMs must be greater than startMs',
    path: ['endMs'],
  });

const itemBaseObjectSchema = z.object({
  id: z.string().min(1).optional(),
  text: z.string().min(1),
  audioUrl: audioUrlSchema,
  order: z.number().int().nonnegative().optional(),
  segments: z.array(segmentSchema).min(1),
  wordTimings: z.array(wordTimingSchema).default([]),
  sentenceTimings: z.array(sentenceTimingSchema).default([]),
  chunkTimings: z.array(chunkTimingSchema).default([]),
});

const refineLessonItemTiming = (
  item: z.infer<typeof itemBaseObjectSchema>,
  ctx: z.RefinementCtx,
) => {
  validateTimingMarks('wordTimings', item.wordTimings, item.segments, ctx);
  validateTimingMarks('sentenceTimings', item.sentenceTimings, item.segments, ctx);
  validateTimingMarks('chunkTimings', item.chunkTimings, item.segments, ctx);

  const wordTimingIds = new Set(item.wordTimings.map((mark) => mark.id).filter(Boolean));
  const validateWordMarkIds = (
    fieldName: 'sentenceTimings' | 'chunkTimings',
    timings: Array<{ wordMarkIds: string[] }>,
  ) => {
    timings.forEach((timing, timingIndex) => {
      timing.wordMarkIds.forEach((wordMarkId, wordIndex) => {
        if (!wordTimingIds.has(wordMarkId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [fieldName, timingIndex, 'wordMarkIds', wordIndex],
            message: `Unknown word timing id: ${wordMarkId}`,
          });
        }
      });
    });
  };
  validateWordMarkIds('sentenceTimings', item.sentenceTimings);
  validateWordMarkIds('chunkTimings', item.chunkTimings);
};

const itemBaseSchema = itemBaseObjectSchema.superRefine(refineLessonItemTiming);

const createLessonSchema = lessonBaseSchema.extend({
  items: z.array(itemBaseSchema).optional(),
});

const updateLessonSchema = lessonBaseSchema.partial().extend({
  items: z.array(itemBaseSchema).optional(),
});

const createItemSchema = itemBaseObjectSchema.omit({ id: true }).superRefine(refineLessonItemTiming);

const generateTimingsSchema = z.object({
  text: z.string().trim().min(1).optional(),
});

const updateSegmentTimingsSchema = z
  .object({
    segment: segmentSchema,
    wordTimings: z.array(wordTimingSchema).default([]),
    chunkTimings: z.array(chunkTimingSchema).default([]),
  })
  .superRefine((payload, ctx) => {
    validateTimingMarks('wordTimings', payload.wordTimings, [payload.segment], ctx);
    validateTimingMarks('chunkTimings', payload.chunkTimings, [payload.segment], ctx);

    payload.wordTimings.forEach((mark, index) => {
      if (!isTimingInsideSegment(mark, payload.segment)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['wordTimings', index, 'startMs'],
          message: 'Word timing must start inside the segment being saved',
        });
      }
    });
    payload.chunkTimings.forEach((mark, index) => {
      if (!isTimingInsideSegment(mark, payload.segment)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['chunkTimings', index, 'startMs'],
          message: 'Chunk timing must start inside the segment being saved',
        });
      }
    });

    const wordTimingIds = new Set(payload.wordTimings.map((mark) => mark.id).filter(Boolean));
    payload.chunkTimings.forEach((timing, timingIndex) => {
      timing.wordMarkIds.forEach((wordMarkId, wordIndex) => {
        if (!wordTimingIds.has(wordMarkId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['chunkTimings', timingIndex, 'wordMarkIds', wordIndex],
            message: `Unknown word timing id: ${wordMarkId}`,
          });
        }
      });
    });
  });

function validateTimingMarks(
  fieldName: 'wordTimings' | 'sentenceTimings' | 'chunkTimings',
  marks: Array<{ startMs: number; endMs: number; order?: number }>,
  segments: Array<{ endMs: number }>,
  ctx: z.RefinementCtx,
) {
  let previousOrder = -1;
  const timelineEndMs = segments.length ? Math.max(...segments.map((segment) => segment.endMs)) : null;

  marks.forEach((mark, index) => {
    const order = mark.order ?? index;
    if (order < previousOrder) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [fieldName, index, 'order'],
        message: `${fieldName} must be sorted by order`,
      });
    }
    previousOrder = order;

    if (timelineEndMs !== null && mark.endMs > timelineEndMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [fieldName, index, 'endMs'],
        message: `${fieldName} must be contained within the item audio timeline`,
      });
    }
  });
}

type ParsedLessonItem = z.infer<typeof itemBaseSchema>;

function normalizeLessonItemPayload(item: ParsedLessonItem, index: number) {
  return {
    id: item.id,
    order: item.order ?? index,
    text: item.text,
    audioUrl: item.audioUrl,
    segments: item.segments,
    wordTimings: item.wordTimings.map((mark, markIndex) => ({
      id: mark.id ?? `word-${markIndex + 1}`,
      text: mark.text,
      normalizedText: mark.normalizedText ?? canonicalizeVocabularyText(mark.text),
      startMs: mark.startMs,
      endMs: mark.endMs,
      order: mark.order ?? markIndex,
    })),
    sentenceTimings: item.sentenceTimings.map((mark, markIndex) => ({
      id: mark.id ?? `sentence-${markIndex + 1}`,
      text: mark.text,
      startMs: mark.startMs,
      endMs: mark.endMs,
      wordMarkIds: mark.wordMarkIds,
      order: mark.order ?? markIndex,
    })),
    chunkTimings: item.chunkTimings.map((mark, markIndex) => ({
      id: mark.id ?? `chunk-${markIndex + 1}`,
      text: mark.text,
      normalizedText: mark.normalizedText ?? canonicalizeVocabularyText(mark.text),
      startMs: mark.startMs,
      endMs: mark.endMs,
      wordMarkIds: mark.wordMarkIds,
      order: mark.order ?? markIndex,
    })),
  };
}

function isTimingInsideSegment(
  mark: { startMs: number; endMs: number },
  segment: { startMs: number; endMs: number },
) {
  return mark.startMs >= segment.startMs && mark.startMs < segment.endMs;
}

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

router.get('/lessons', authenticate, async (req: AuthenticatedRequest, res) => {
  const where = req.user?.role === 'learner' ? { status: 'PUBLISHED' as const } : undefined;
  const lessons = await prisma.lesson.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    include: {
      items: {
        orderBy: { order: 'asc' },
      },
    },
  });
  return res.json({ lessons });
});

router.get('/lessons/:id', authenticate, async (req: AuthenticatedRequest, res) => {
  const where =
    req.user?.role === 'learner'
      ? { id: req.params.id, status: 'PUBLISHED' as const }
      : { id: req.params.id };

  const lesson = await prisma.lesson.findFirst({
    where,
    include: {
      items: {
        orderBy: { order: 'asc' },
      },
    },
  });
  if (!lesson) {
    return res.status(404).json({ message: 'Lesson not found' });
  }

  const lessonVocabulary = await buildLessonVocabularyPayload(
    prisma,
    lesson.id,
    lesson.items.map((item) => item.text),
  );

  return res.json({
    lesson: {
      ...lesson,
      dictionary: lessonVocabulary.vocabulary,
      dictionaryCoverage: lessonVocabulary.coverage,
      vocabulary: lessonVocabulary.vocabulary,
      vocabularyCoverage: lessonVocabulary.coverage,
    },
  });
});

router.post('/lessons', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  const parsed = createLessonSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const { title, description, status, items } = parsed.data;
  const normalizedItems = items?.map(normalizeLessonItemPayload);
  const created = await prisma.lesson.create({
    data: {
      title,
      description,
      status: status ?? 'DRAFT',
      publishedAt: status === 'PUBLISHED' ? new Date() : null,
      authorId: req.user!.id,
      items: normalizedItems
        ? {
            create: normalizedItems.map((item) => ({
              id: item.id,
              order: item.order,
              text: item.text,
              audioUrl: item.audioUrl,
              segments: item.segments,
              wordTimings: item.wordTimings,
              sentenceTimings: item.sentenceTimings,
              chunkTimings: item.chunkTimings,
            })),
          }
        : undefined,
    },
    include: {
      items: { orderBy: { order: 'asc' } },
    },
  });

  const lessonVocabulary = await buildLessonVocabularyPayload(
    prisma,
    created.id,
    created.items.map((item) => item.text),
  );

  return res.status(201).json({
    lesson: {
      ...created,
      dictionary: lessonVocabulary.vocabulary,
      dictionaryCoverage: lessonVocabulary.coverage,
      vocabulary: lessonVocabulary.vocabulary,
      vocabularyCoverage: lessonVocabulary.coverage,
    },
  });
});

router.patch('/lessons/:id', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  const parsed = updateLessonSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const existing = await prisma.lesson.findUnique({
    where: { id: req.params.id },
    include: { items: { orderBy: { order: 'asc' } } },
  });
  if (!existing) {
    return res.status(404).json({ message: 'Lesson not found' });
  }

  const { title, description, status, items } = parsed.data;
  const normalizedItems = items?.map(normalizeLessonItemPayload);
  await prisma.$transaction(async (tx) => {
    await tx.lesson.update({
      where: { id: req.params.id },
      data: {
        title: title ?? existing.title,
        description: description ?? existing.description,
        status: status ?? existing.status,
        publishedAt:
          status === 'PUBLISHED'
            ? existing.publishedAt ?? new Date()
            : status === 'DRAFT'
              ? null
              : existing.publishedAt,
      },
    });

    if (normalizedItems) {
      await tx.lessonItem.deleteMany({ where: { lessonId: req.params.id } });
      if (normalizedItems.length) {
        await tx.lessonItem.createMany({
          data: normalizedItems.map((item) => ({
            id: item.id,
            lessonId: req.params.id,
            order: item.order,
            text: item.text,
            audioUrl: item.audioUrl,
            segments: item.segments,
            wordTimings: item.wordTimings,
            sentenceTimings: item.sentenceTimings,
            chunkTimings: item.chunkTimings,
          })),
        });
      }
    }
  });

  const updated = await prisma.lesson.findUnique({
    where: { id: req.params.id },
    include: {
      items: { orderBy: { order: 'asc' } },
    },
  });

  if (!updated) {
    return res.status(404).json({ message: 'Lesson not found' });
  }

  const lessonVocabulary = await buildLessonVocabularyPayload(
    prisma,
    updated.id,
    updated.items.map((item) => item.text),
  );

  return res.json({
    lesson: {
      ...updated,
      dictionary: lessonVocabulary.vocabulary,
      dictionaryCoverage: lessonVocabulary.coverage,
      vocabulary: lessonVocabulary.vocabulary,
      vocabularyCoverage: lessonVocabulary.coverage,
    },
  });
});

router.patch(
  '/lessons/:lessonId/items/:itemId/segments/:segmentId/timings',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;

    const parsed = updateSegmentTimingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const item = await prisma.lessonItem.findFirst({
      where: {
        id: req.params.itemId,
        lessonId: req.params.lessonId,
      },
    });
    if (!item) {
      return res.status(404).json({ message: 'Lesson item not found' });
    }

    const existingSegments = Array.isArray(item.segments) ? item.segments : [];
    const segmentIndex = existingSegments.findIndex(
      (segment) =>
        typeof segment === 'object' &&
        segment !== null &&
        'id' in segment &&
        segment.id === req.params.segmentId,
    );
    if (segmentIndex === -1) {
      return res.status(404).json({ message: 'Lesson segment not found' });
    }

    const existingSegment = existingSegments[segmentIndex] as z.infer<typeof segmentSchema>;
    const { segment, wordTimings, chunkTimings } = parsed.data;
    const normalizedWords = wordTimings.map((mark, markIndex) => ({
      id: mark.id ?? `word-${Date.now()}-${markIndex + 1}`,
      text: mark.text,
      normalizedText: mark.normalizedText ?? canonicalizeVocabularyText(mark.text),
      startMs: mark.startMs,
      endMs: mark.endMs,
      order: mark.order ?? markIndex,
    }));
    const normalizedChunks = chunkTimings.map((mark, markIndex) => ({
      id: mark.id ?? `chunk-${Date.now()}-${markIndex + 1}`,
      text: mark.text,
      normalizedText: mark.normalizedText ?? canonicalizeVocabularyText(mark.text),
      startMs: mark.startMs,
      endMs: mark.endMs,
      wordMarkIds: mark.wordMarkIds,
      order: mark.order ?? markIndex,
    }));
    const segmentSentenceTiming = normalizedWords.length
      ? [
          {
            id: `sentence-${segment.id}`,
            text: segment.text,
            startMs: segment.startMs,
            endMs: segment.endMs,
            wordMarkIds: normalizedWords.map((word) => word.id),
            order: 0,
          },
        ]
      : [];

    const nextSegments = existingSegments.map((entry, index) =>
      index === segmentIndex ? segment : entry,
    );
    const existingWordTimings = Array.isArray(item.wordTimings) ? item.wordTimings : [];
    const existingSentenceTimings = Array.isArray(item.sentenceTimings)
      ? item.sentenceTimings
      : [];
    const existingChunkTimings = Array.isArray(item.chunkTimings) ? item.chunkTimings : [];
    const nextWordTimings = [
      ...existingWordTimings.filter(
        (mark) =>
          typeof mark === 'object' &&
          mark !== null &&
          !isTimingInsideSegment(mark as { startMs: number; endMs: number }, existingSegment),
      ),
      ...normalizedWords,
    ]
      .sort((left, right) => {
        const leftTiming = left as { startMs: number; endMs: number };
        const rightTiming = right as { startMs: number; endMs: number };
        return leftTiming.startMs - rightTiming.startMs || leftTiming.endMs - rightTiming.endMs;
      })
      .map((mark, index) => ({ ...(mark as object), order: index }));
    const nextSentenceTimings = [
      ...existingSentenceTimings.filter(
        (mark) =>
          typeof mark === 'object' &&
          mark !== null &&
          !isTimingInsideSegment(mark as { startMs: number; endMs: number }, existingSegment),
      ),
      ...segmentSentenceTiming,
    ]
      .sort((left, right) => {
        const leftTiming = left as { startMs: number; endMs: number };
        const rightTiming = right as { startMs: number; endMs: number };
        return leftTiming.startMs - rightTiming.startMs || leftTiming.endMs - rightTiming.endMs;
      })
      .map((mark, index) => ({ ...(mark as object), order: index }));
    const nextChunkTimings = [
      ...existingChunkTimings.filter(
        (mark) =>
          typeof mark === 'object' &&
          mark !== null &&
          !isTimingInsideSegment(mark as { startMs: number; endMs: number }, existingSegment),
      ),
      ...normalizedChunks,
    ]
      .sort((left, right) => {
        const leftTiming = left as { startMs: number; endMs: number };
        const rightTiming = right as { startMs: number; endMs: number };
        return leftTiming.startMs - rightTiming.startMs || leftTiming.endMs - rightTiming.endMs;
      })
      .map((mark, index) => ({ ...(mark as object), order: index }));

    const updated = await prisma.lessonItem.update({
      where: { id: item.id },
      data: {
        segments: nextSegments,
        wordTimings: nextWordTimings,
        sentenceTimings: nextSentenceTimings,
        chunkTimings: nextChunkTimings,
      },
    });

    return res.json({ item: updated });
  },
);

router.post(
  '/lessons/:lessonId/items/:itemId/transcribe-timings',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;

    const parsed = generateTimingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const item = await prisma.lessonItem.findFirst({
      where: {
        id: req.params.itemId,
        lessonId: req.params.lessonId,
      },
    });
    if (!item) {
      return res.status(404).json({ message: 'Lesson item not found' });
    }
    if (!item.audioUrl) {
      return res.status(400).json({ message: 'Upload audio before generating timings.' });
    }

    const audioPath = resolveStoredAudioPath(item.audioUrl);
    if (!audioPath) {
      return res.status(400).json({
        message: 'AI timing generation currently supports uploaded lesson audio files only.',
      });
    }

    try {
      const lessonText = parsed.data.text ?? item.text;
      const transcription = await transcribeAudioWithWordTimestamps({
        audioPath,
        prompt: lessonText,
      });
      const timings = generateLessonTimingsFromTranscript({
        lessonText,
        transcriptText: transcription.text,
        transcriptWords: transcription.words,
      });
      try {
        const suggestedChunks = await suggestLogicalTimingChunks({
          lessonText,
          wordTimings: timings.wordTimings,
        });
        const chunkTimings = buildLogicalChunkTimings({
          suggestedChunks,
          wordTimings: timings.wordTimings,
        });
        if (chunkTimings.some((chunk) => chunk.wordMarkIds.length > 1)) {
          timings.chunkTimings = chunkTimings;
        } else {
          timings.chunkTimings = buildHeuristicLogicalChunkTimings(timings.wordTimings);
          timings.warnings.push('OpenAI returned only single-word chunks; local logical chunks were generated.');
        }
      } catch (chunkError) {
        const chunkMessage =
          chunkError instanceof Error ? chunkError.message : 'Failed to generate logical timing chunks';
        timings.chunkTimings = buildHeuristicLogicalChunkTimings(timings.wordTimings);
        timings.warnings.push(`OpenAI logical chunking skipped; local logical chunks were generated: ${chunkMessage}`);
      }

      if (!timings.segments.length || !timings.wordTimings.length) {
        return res.status(422).json({
          message: 'Could not align the audio transcript to this lesson text.',
          timings,
        });
      }

      return res.json({ timings });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate timings';
      const status = message.includes('OPENAI_API_KEY') ? 503 : 502;
      return res.status(status).json({ message });
    }
  },
);

router.delete('/lessons/:id', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const existing = await prisma.lesson.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!existing) {
      return res.status(404).json({ message: 'Lesson not found' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.learnerLessonVocabularyEntry.deleteMany({
        where: { lessonId: req.params.id },
      });
      await tx.lessonVocabularyEntry.deleteMany({
        where: { lessonId: req.params.id },
      });
      await tx.lessonItem.deleteMany({
        where: { lessonId: req.params.id },
      });
      await tx.lesson.delete({ where: { id: req.params.id } });
    });
    return res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return res.status(404).json({ message: 'Lesson not found' });
    }
    console.error('Failed to delete lesson', error);
    return res.status(500).json({ message: 'Failed to delete lesson' });
  }
});

router.post('/lessons/:lessonId/items', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  const parsed = createItemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const lesson = await prisma.lesson.findUnique({ where: { id: req.params.lessonId } });
  if (!lesson) {
    return res.status(404).json({ message: 'Lesson not found' });
  }

  const itemCount = await prisma.lessonItem.count({ where: { lessonId: lesson.id } });
  const normalizedItem = normalizeLessonItemPayload(parsed.data, itemCount);
  const created = await prisma.lessonItem.create({
    data: {
      lessonId: lesson.id,
      text: normalizedItem.text,
      audioUrl: normalizedItem.audioUrl,
      order: normalizedItem.order,
      segments: normalizedItem.segments,
      wordTimings: normalizedItem.wordTimings,
      sentenceTimings: normalizedItem.sentenceTimings,
      chunkTimings: normalizedItem.chunkTimings,
    },
  });

  return res.status(201).json({ item: created });
});

router.delete(
  '/lessons/:lessonId/items/:itemId',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const item = await prisma.lessonItem.findFirst({
      where: { id: req.params.itemId, lessonId: req.params.lessonId },
    });
    if (!item) {
      return res.status(404).json({ message: 'Lesson item not found' });
    }
    await prisma.lessonItem.delete({ where: { id: item.id } });
    return res.status(204).send();
  },
);

export { router as lessonsRouter };
