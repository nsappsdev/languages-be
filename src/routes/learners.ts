import { Response, Router } from 'express';
import { Prisma } from '@prisma/client';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';

const router = Router();

type LearnerSummary = {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  vocabularySaved: number;
  progressEvents: number;
};

const ensureAdmin = (req: AuthenticatedRequest, res: Response) => {
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

const buildLearnerSummary = async (learners: Array<{
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}>): Promise<LearnerSummary[]> => {
  if (!learners.length) {
    return [];
  }

  const learnerIds = learners.map((learner) => learner.id);
  const [vocabularyCounts, progressCounts] = await Promise.all([
    prisma.learnerVocabulary.groupBy({
      by: ['userId'],
      where: { userId: { in: learnerIds } },
      _count: { _all: true },
    }),
    prisma.$queryRaw<Array<{ userId: string; count: number }>>(Prisma.sql`
      SELECT "userId", COUNT(*)::int AS "count"
      FROM "LearnerProgressEvent"
      WHERE "userId" IN (${Prisma.join(learnerIds)})
      GROUP BY "userId"
    `),
  ]);

  const vocabularyByLearner = new Map(
    vocabularyCounts.map((item) => [item.userId, item._count._all]),
  );
  const progressByLearner = new Map(
    progressCounts.map((item) => [item.userId, Number(item.count)]),
  );

  return learners.map((learner) => ({
    id: learner.id,
    email: learner.email,
    name: learner.name,
    createdAt: learner.createdAt,
    updatedAt: learner.updatedAt,
    vocabularySaved: vocabularyByLearner.get(learner.id) ?? 0,
    progressEvents: progressByLearner.get(learner.id) ?? 0,
  }));
};

router.get('/learners', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!ensureAdmin(req, res)) {
    return;
  }
  const learners = await prisma.user.findMany({
    where: { role: 'learner' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const summarized = await buildLearnerSummary(learners);
  return res.json({ learners: summarized });
});

type LearnerLessonProgressRow = {
  lessonId: string;
  lessonTitle: string | null;
  lessonStatus: string | null;
  totalEvents: number;
  itemsStarted: number;
  itemsCompleted: number;
  bestCompletion: number | null;
  lastCompletion: number | null;
  lastActivityAt: Date;
};

router.get('/learners/:learnerId/progress-summary', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!ensureAdmin(req, res)) {
    return;
  }

  const learnerId = req.params.learnerId;
  const learner = await prisma.user.findFirst({
    where: { id: learnerId, role: 'learner' },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!learner) {
    return res.status(404).json({ message: 'Learner not found' });
  }

  const [summary] = await buildLearnerSummary([learner]);
  const lessonSummaries = await prisma.$queryRaw<LearnerLessonProgressRow[]>(Prisma.sql`
    SELECT
      event_stats."lessonId" AS "lessonId",
      lesson."title" AS "lessonTitle",
      lesson."status"::text AS "lessonStatus",
      event_stats."totalEvents" AS "totalEvents",
      event_stats."itemsStarted" AS "itemsStarted",
      event_stats."itemsCompleted" AS "itemsCompleted",
      event_stats."bestCompletion" AS "bestCompletion",
      latest_completion."completion" AS "lastCompletion",
      event_stats."lastActivityAt" AS "lastActivityAt"
    FROM (
      SELECT
        event."lessonId" AS "lessonId",
        COUNT(*)::int AS "totalEvents",
        COUNT(DISTINCT event."lessonItemId") FILTER (WHERE event."eventType" = 'ITEM_STARTED')::int AS "itemsStarted",
        COUNT(DISTINCT event."lessonItemId") FILTER (WHERE event."eventType" = 'ITEM_COMPLETED')::int AS "itemsCompleted",
        MAX(event."completion")::int AS "bestCompletion",
        MAX(event."createdAt") AS "lastActivityAt"
      FROM "LearnerProgressEvent" event
      WHERE event."userId" = ${learnerId}
      GROUP BY event."lessonId"
    ) event_stats
    LEFT JOIN "Lesson" lesson
      ON lesson."id" = event_stats."lessonId"
    LEFT JOIN LATERAL (
      SELECT event."completion"
      FROM "LearnerProgressEvent" event
      WHERE event."userId" = ${learnerId}
        AND event."lessonId" = event_stats."lessonId"
        AND event."eventType" = 'LESSON_COMPLETED'
        AND event."completion" IS NOT NULL
      ORDER BY event."createdAt" DESC
      LIMIT 1
    ) latest_completion
      ON TRUE
    ORDER BY event_stats."lastActivityAt" DESC
  `);

  return res.json({
    learner: summary,
    lessonSummaries,
  });
});

export { router as learnersRouter };
