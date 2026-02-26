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

const taskOptionSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1),
  isCorrect: z.boolean().optional().default(false),
});

const taskBaseSchema = z.object({
  id: z.string().optional(),
  prompt: z.string().min(4),
  type: z.enum(['PICK_ONE', 'FILL_IN_BLANK', 'MATCH']),
  order: z.number().int().nonnegative().optional(),
  config: z.record(z.any()).optional().default({}),
  options: z.array(taskOptionSchema).optional(),
});

const createLessonSchema = lessonBaseSchema.extend({
  tasks: z.array(taskBaseSchema).optional(),
});

const updateLessonSchema = lessonBaseSchema.partial().extend({
  tasks: z.array(taskBaseSchema).optional(),
});

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
      tasks: {
        orderBy: { order: 'asc' },
        include: { options: true },
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
      tasks: {
        orderBy: { order: 'asc' },
        include: { options: true },
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
  const { title, description, status, tasks } = parsed.data;
  const created = await prisma.lesson.create({
    data: {
      title,
      description,
      status: status ?? 'DRAFT',
      publishedAt: status === 'PUBLISHED' ? new Date() : null,
      authorId: req.user!.id,
      tasks: tasks
        ? {
            create: tasks.map((task, index) => ({
              prompt: task.prompt,
              type: task.type,
              order: task.order ?? index,
              config: task.config ?? {},
              options: task.options
                ? {
                    create: task.options.map((option) => ({
                      label: option.label,
                      isCorrect: option.isCorrect ?? false,
                    })),
                  }
                : undefined,
            })),
          }
        : undefined,
    },
    include: {
      tasks: { include: { options: true }, orderBy: { order: 'asc' } },
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

  const existing = await prisma.lesson.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ message: 'Lesson not found' });
  }

  const { title, description, status, tasks } = parsed.data;

  const lesson = await prisma.lesson.update({
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

  if (tasks) {
    for (const task of tasks) {
      if (task.id) {
        await prisma.task.update({
          where: { id: task.id },
          data: {
            prompt: task.prompt,
            type: task.type,
            order: task.order ?? 0,
            config: task.config ?? {},
          },
        });
        if (task.options) {
          const keepIds: string[] = [];
          for (const option of task.options) {
            if (option.id) {
              await prisma.taskOption.update({
                where: { id: option.id },
                data: { label: option.label, isCorrect: option.isCorrect ?? false },
              });
              keepIds.push(option.id);
            } else {
              const createdOption = await prisma.taskOption.create({
                data: {
                  taskId: task.id as string,
                  label: option.label,
                  isCorrect: option.isCorrect ?? false,
                },
              });
              keepIds.push(createdOption.id);
            }
          }
          await prisma.taskOption.deleteMany({
            where: {
              taskId: task.id as string,
              ...(keepIds.length ? { id: { notIn: keepIds } } : {}),
            },
          });
        }
      } else {
        await prisma.task.create({
          data: {
            lessonId: lesson.id,
            prompt: task.prompt,
            type: task.type,
            order: task.order ?? 0,
            config: task.config ?? {},
            options: task.options
              ? {
                  create: task.options.map((option) => ({
                    label: option.label,
                    isCorrect: option.isCorrect ?? false,
                  })),
                }
              : undefined,
          },
        });
      }
    }
  }

  const updated = await prisma.lesson.findUnique({
    where: { id: lesson.id },
    include: {
      tasks: { orderBy: { order: 'asc' }, include: { options: true } },
    },
  });

  return res.json({ lesson: updated });
});

router.delete('/lessons/:id', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    await prisma.lesson.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch (error) {
    return res.status(404).json({ message: 'Lesson not found' });
  }
});

router.post(
  '/lessons/:lessonId/tasks',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const parsed = taskBaseSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const lesson = await prisma.lesson.findUnique({ where: { id: req.params.lessonId } });
    if (!lesson) {
      return res.status(404).json({ message: 'Lesson not found' });
    }

    const taskCount = await prisma.task.count({ where: { lessonId: lesson.id } });
    const created = await prisma.task.create({
      data: {
        lessonId: lesson.id,
        prompt: parsed.data.prompt,
        type: parsed.data.type,
        order: parsed.data.order ?? taskCount,
        config: parsed.data.config ?? {},
        options: parsed.data.options
          ? {
              create: parsed.data.options.map((option) => ({
                label: option.label,
                isCorrect: option.isCorrect ?? false,
              })),
            }
          : undefined,
      },
      include: { options: true },
    });

    return res.status(201).json({ task: created });
  },
);

router.delete(
  '/lessons/:lessonId/tasks/:taskId',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const task = await prisma.task.findFirst({
      where: { id: req.params.taskId, lessonId: req.params.lessonId },
    });
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    await prisma.task.delete({ where: { id: task.id } });
    return res.status(204).send();
  },
);

export { router as lessonsRouter };
