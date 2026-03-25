import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';

const router = Router();

router.get('/analytics/overview', authenticate, async (_req: AuthenticatedRequest, res) => {
  const [totalLessons, publishedLessons, totalItems, latestLesson] = await Promise.all([
    prisma.lesson.count(),
    prisma.lesson.count({ where: { status: 'PUBLISHED' } }),
    prisma.lessonItem.count(),
    prisma.lesson.findFirst({
      where: { status: 'PUBLISHED' },
      orderBy: { publishedAt: 'desc' },
      select: { title: true, publishedAt: true },
    }),
  ]);

  const draftLessons = totalLessons - publishedLessons;
  const avgItemsPerLesson = totalLessons > 0 ? Number((totalItems / totalLessons).toFixed(1)) : 0;

  return res.json({
    stats: {
      totalLessons,
      publishedLessons,
      draftLessons,
      totalItems,
      avgItemsPerLesson,
      latestPublishedLesson: latestLesson
        ? {
          title: latestLesson.title,
          publishedAt: latestLesson.publishedAt,
        }
        : null,
    },
  });
});

export { router as analyticsRouter };
