import { Response, Router } from 'express';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';

const router = Router();

const lessonBaseSchema = z.object({
  title: z.string().min(2),
  description: z.string().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
});

const audioUrlSchema = z.string().trim().min(1).refine(
  (value) => value.startsWith('/') || /^https?:\/\//i.test(value),
  {
    message: 'audioUrl must be an absolute URL or a root-relative media path',
  },
);

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

const itemBaseSchema = z.object({
  id: z.string().min(1).optional(),
  text: z.string().min(1),
  audioUrl: audioUrlSchema,
  order: z.number().int().nonnegative().optional(),
  segments: z.array(segmentSchema).min(1),
});

const createLessonSchema = lessonBaseSchema.extend({
  items: z.array(itemBaseSchema).optional(),
});

const updateLessonSchema = lessonBaseSchema.partial().extend({
  items: z.array(itemBaseSchema).optional(),
});

const createItemSchema = itemBaseSchema.omit({ id: true });

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
  return res.json({ lesson });
});

router.post('/lessons', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  const parsed = createLessonSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const { title, description, status, items } = parsed.data;
  const created = await prisma.lesson.create({
    data: {
      title,
      description,
      status: status ?? 'DRAFT',
      publishedAt: status === 'PUBLISHED' ? new Date() : null,
      authorId: req.user!.id,
      items: items
        ? {
            create: items.map((item, index) => ({
              id: item.id,
              order: item.order ?? index,
              text: item.text,
              audioUrl: item.audioUrl,
              segments: item.segments,
            })),
          }
        : undefined,
    },
    include: {
      items: { orderBy: { order: 'asc' } },
    },
  });

  return res.status(201).json({ lesson: created });
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

    if (items) {
      await tx.lessonItem.deleteMany({ where: { lessonId: req.params.id } });
      if (items.length) {
        await tx.lessonItem.createMany({
          data: items.map((item, index) => ({
            id: item.id,
            lessonId: req.params.id,
            order: item.order ?? index,
            text: item.text,
            audioUrl: item.audioUrl,
            segments: item.segments,
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

  return res.json({ lesson: updated });
});

router.delete('/lessons/:id', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    await prisma.lesson.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch {
    return res.status(404).json({ message: 'Lesson not found' });
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
  const created = await prisma.lessonItem.create({
    data: {
      lessonId: lesson.id,
      text: parsed.data.text,
      audioUrl: parsed.data.audioUrl,
      order: parsed.data.order ?? itemCount,
      segments: parsed.data.segments,
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
