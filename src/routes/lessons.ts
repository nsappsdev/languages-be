import { Response, Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';
import { ReaderReleaseError } from '../lib/readerRelease';
import { lockLesson } from '../lib/authoringTransaction';
import { saveContentRevisionInTransaction } from '../lib/textWorkspaces';

const router = Router();
const textSchema = z.string().min(1).max(5000).refine(text => text.trim().length > 0, 'Text cannot be blank');
const metadata = z.object({ title: z.string().trim().min(2).max(300), description: z.string().max(5000).nullable().optional() });
const createSchema = metadata.extend({ items: z.array(z.object({ text: textSchema }).strict()).min(1).max(100) }).strict();
// Existing text is edited only through content-revisions; this list controls order.
const updateSchema = metadata.partial().extend({ items: z.array(z.object({ id: z.string().min(1) }).strict()).min(1).max(100).optional() }).strict();
const itemSelect = { id: true, lessonId: true, order: true, textWorkspace: { select: { currentContentRevisionId: true } } } satisfies Prisma.LessonItemSelect;

async function lessonDto(db: Prisma.TransactionClient, id: string) {
  const lesson = await db.lesson.findUnique({ where: { id }, select: {
    id: true, title: true, description: true, currentPublicationId: true,
    items: { where: { archivedAt: null }, orderBy: { order: 'asc' }, select: itemSelect },
  } });
  if (!lesson) throw new ReaderReleaseError(404, 'Lesson not found');
  const revisions = await db.textContentRevision.findMany({ where: { id: { in: lesson.items.flatMap(i => i.textWorkspace?.currentContentRevisionId ? [i.textWorkspace.currentContentRevisionId] : []) } } });
  return { ...lesson, status: lesson.currentPublicationId ? 'PUBLISHED' : 'DRAFT', items: lesson.items.map(({ textWorkspace, ...item }) => ({
    ...item, text: revisions.find(r => r.id === textWorkspace?.currentContentRevisionId)?.text ?? '',
  })) };
}
const run = (fn: (req: AuthenticatedRequest, res: Response) => Promise<unknown>) =>
  (req: AuthenticatedRequest, res: Response) => {
    if (req.user?.role !== 'admin') { res.status(403).json({ message: 'Admin access required. Use the learner reader API.' }); return; }
    void fn(req, res).catch(error => {
      if (error instanceof ReaderReleaseError) return res.status(error.status).json({ message: error.message, ...error.details });
      console.error('Lesson authoring failed', error);
      res.status(500).json({ message: 'Unable to save lesson' });
    });
  };

router.get('/lessons', authenticate, run(async (_req, res) => {
  const lessons = await prisma.$transaction(async tx => {
    const ids = await tx.lesson.findMany({ orderBy: { updatedAt: 'desc' }, select: { id: true } });
    return Promise.all(ids.map(l => lessonDto(tx, l.id)));
  });
  return res.json({ lessons });
}));
router.get('/lessons/:id', authenticate, run(async (req, res) => res.json({ lesson: await lessonDto(prisma, req.params.id) })));
router.post('/lessons', authenticate, run(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Provide a title and one or more texts', issues: parsed.error.flatten() });
  const lesson = await prisma.$transaction(async tx => {
    const created = await tx.lesson.create({ data: { title: parsed.data.title, description: parsed.data.description, authorId: req.user!.id } });
    for (const [order, input] of parsed.data.items.entries()) {
      const item = await tx.lessonItem.create({ data: { lessonId: created.id, order, text: input.text } });
      await saveContentRevisionInTransaction(tx, { textId: item.id, actorId: req.user!.id, text: input.text, sourceLanguage: 'en' });
    }
    return lessonDto(tx, created.id);
  });
  return res.status(201).json({ lesson });
}));
router.patch('/lessons/:id', authenticate, run(async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid lesson changes', issues: parsed.error.flatten() });
  const lesson = await prisma.$transaction(async tx => {
    await lockLesson(tx, req.params.id);
    const { items, ...changes } = parsed.data;
    await tx.lesson.update({ where: { id: req.params.id }, data: changes });
    if (items) {
      const existing = await tx.lessonItem.findMany({ where: { lessonId: req.params.id }, select: { id: true, order: true, archivedAt: true } });
      const active = existing.filter(i => !i.archivedAt);
      if (new Set(items.map(i => i.id)).size !== items.length || items.some(i => !active.some(e => e.id === i.id)))
        throw new ReaderReleaseError(409, 'Text list changed. Reload the lesson.');
      const floor = Math.min(0, ...existing.map(i => i.order)) - active.length - 1;
      for (const [index, item] of active.entries()) {
        const removed = !items.some(i => i.id === item.id);
        await tx.lessonItem.update({ where: { id: item.id }, data: { order: floor - index, ...(removed ? { archivedAt: new Date() } : {}) } });
        if (removed) await tx.textWorkspace.update({ where: { textId: item.id }, data: { archivedAt: new Date() } });
      }
      for (const [order, item] of items.entries()) await tx.lessonItem.update({ where: { id: item.id }, data: { order } });
    }
    return lessonDto(tx, req.params.id);
  });
  return res.json({ lesson });
}));
router.post('/lessons/:lessonId/items', authenticate, run(async (req, res) => {
  const parsed = z.object({ text: textSchema }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Provide the new text' });
  const item = await prisma.$transaction(async tx => {
    await lockLesson(tx, req.params.lessonId);
    const count = await tx.lessonItem.count({ where: { lessonId: req.params.lessonId, archivedAt: null } });
    if (count >= 100) throw new ReaderReleaseError(422, 'A lesson can contain up to 100 texts');
    const last = await tx.lessonItem.aggregate({ where: { lessonId: req.params.lessonId, archivedAt: null }, _max: { order: true } });
    const created = await tx.lessonItem.create({ data: { lessonId: req.params.lessonId, order: (last._max.order ?? -1) + 1, text: parsed.data.text } });
    await saveContentRevisionInTransaction(tx, { textId: created.id, actorId: req.user!.id, text: parsed.data.text, sourceLanguage: 'en' });
    return { id: created.id };
  });
  return res.status(201).json({ item });
}));

export { router as lessonsRouter };
