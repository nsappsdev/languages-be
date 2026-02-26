import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';

const router = Router();

const progressEventSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128),
  lessonId: z.string().trim().min(1),
  taskId: z.string().trim().min(1).optional(),
  eventType: z.enum(['TASK_ATTEMPT', 'TASK_COMPLETED', 'LESSON_COMPLETED']),
  attemptNumber: z.number().int().positive().max(100).optional(),
  isCorrect: z.boolean().optional(),
  score: z.number().int().min(0).max(100).optional(),
  completion: z.number().int().min(0).max(100).optional(),
  clientTimestamp: z.string().datetime().optional(),
  payload: z.record(z.any()).optional(),
});

const progressBatchSchema = z.object({
  events: z.array(progressEventSchema).min(1).max(50),
});

router.post('/me/progress/events', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  if (req.user.role !== 'learner') {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const parsed = progressBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const userId = req.user.id;
  const acceptedResults = await prisma.$transaction(
    parsed.data.events.map((event) => {
      const payloadJson = event.payload ? JSON.stringify(event.payload) : null;
      return prisma.$executeRaw(Prisma.sql`
        INSERT INTO "LearnerProgressEvent" (
          "id",
          "userId",
          "lessonId",
          "taskId",
          "eventType",
          "attemptNumber",
          "isCorrect",
          "score",
          "completion",
          "clientTimestamp",
          "idempotencyKey",
          "payload",
          "createdAt"
        )
        VALUES (
          ${createEventRowId()},
          ${userId},
          ${event.lessonId},
          ${event.taskId ?? null},
          ${event.eventType}::"ProgressEventType",
          ${event.attemptNumber ?? null},
          ${event.isCorrect ?? null},
          ${event.score ?? null},
          ${event.completion ?? null},
          ${event.clientTimestamp ? new Date(event.clientTimestamp) : null},
          ${event.idempotencyKey},
          ${payloadJson ? Prisma.sql`CAST(${payloadJson} AS JSONB)` : Prisma.sql`NULL`},
          NOW()
        )
        ON CONFLICT ("idempotencyKey") DO NOTHING
      `);
    }),
  );

  const accepted = acceptedResults.reduce((sum, result) => sum + Number(result), 0);

  return res.status(202).json({
    accepted,
    received: parsed.data.events.length,
  });
});

export { router as progressRouter };

function createEventRowId() {
  return randomUUID();
}
