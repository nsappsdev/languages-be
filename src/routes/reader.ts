import { Router, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';
import { ReaderReleaseError, inspectReaderDraft, readerAssetIds, validReaderAsset } from '../lib/readerRelease';
import { servePrivateAudio } from '../lib/servePrivateAudio';
import { ReaderManifest, ReaderText } from '../types/reader';
import { computeRequestHash } from '../lib/audioJobs';

const router = Router();
const run = (handler: (req: AuthenticatedRequest, res: Response) => Promise<unknown>) =>
  (req: AuthenticatedRequest, res: Response, _next: NextFunction) => {
    void handler(req, res).catch(error => {
      if (error instanceof ReaderReleaseError) return res.status(error.status).json({ message: error.message });
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034')
        return res.status(409).json({ message: 'Content changed. Reload and try again.' });
      return res.status(500).json({ message: 'Unable to load reader content' });
    });
  };
function admin(req: AuthenticatedRequest) {
  if (req.user?.role !== 'admin') throw new ReaderReleaseError(403, 'Admin access required');
}

router.post('/admin/lessons/:lessonId/reader-publications', authenticate, run(async (req, res) => {
  admin(req);
  const parsed = z.object({ textReleaseIds: z.array(z.string().min(1)).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Provide the approved text release IDs' });
  const publication = await prisma.$transaction(async tx => {
    const lesson = await tx.lesson.findUnique({ where: { id: req.params.lessonId },
      include: { items: { where: { archivedAt: null }, orderBy: { order: 'asc' }, include: { textWorkspace: true } } } });
    if (!lesson) throw new ReaderReleaseError(404, 'Lesson not found');
    if (!lesson.items.length) throw new ReaderReleaseError(422, 'Add and approve at least one text');
    const texts: ReaderText[] = [];
    for (const item of lesson.items) {
      const id = item.textWorkspace?.approvedTextReleaseId;
      const release = id ? await tx.textRelease.findUnique({ where: { id } }) : null;
      if (!release?.manifestSnapshot || release.textId !== item.id)
        throw new ReaderReleaseError(422, 'Approve every current text version before publishing to mobile');
      const { readiness, workspace } = await inspectReaderDraft(tx, item.id);
      if (!readiness.readyForApproval || release.contentRevisionId !== workspace.currentContentRevisionId ||
        release.narrationId !== workspace.currentNarrationId || release.alignmentId !== workspace.currentAlignmentId)
        throw new ReaderReleaseError(422, 'A text has changed or its audio is unavailable. Review and approve it again.');
      texts.push(release.manifestSnapshot as unknown as ReaderText);
    }
    if (JSON.stringify(texts.map(t => t.textReleaseId)) !== JSON.stringify(parsed.data.textReleaseIds))
      throw new ReaderReleaseError(409, 'Approved versions or text order changed. Reload before publishing.');
    const manifest: ReaderManifest = { schemaVersion: 2, lessonId: lesson.id, title: lesson.title, description: lesson.description, texts };
    const assetIds = [...new Set(texts.flatMap(readerAssetIds))];
    const assets = await tx.audioAsset.findMany({ where: { id: { in: assetIds } } });
    if (assets.length !== assetIds.length || !assets.every(validReaderAsset))
      throw new ReaderReleaseError(422, 'An approved audio asset is unavailable. Review the text again.');
    // Repeating the same publication request is harmless and creates no duplicate publication.
    const previous = lesson.currentPublicationId ? await tx.lessonPublication.findUnique({ where: { id: lesson.currentPublicationId } }) : null;
    if (previous && !previous.revokedAt && computeRequestHash(previous.manifest) === computeRequestHash(manifest)) return previous;
    const created = await tx.lessonPublication.create({ data: { lessonId: lesson.id, authorId: req.user!.id,
      manifest: manifest as any, assetIds } });
    await tx.lesson.update({ where: { id: lesson.id }, data: { currentPublicationId: created.id } });
    return created;
  }, { isolationLevel: 'Serializable', timeout: 15000 });
  return res.status(201).json({ publicationId: publication.id });
}));

router.post('/admin/lessons/:lessonId/reader-publications/revoke', authenticate, run(async (req, res) => {
  admin(req);
  await prisma.$transaction([
    prisma.lessonPublication.updateMany({ where: { lessonId: req.params.lessonId, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.lesson.update({ where: { id: req.params.lessonId }, data: { currentPublicationId: null } }),
  ]);
  return res.json({ revoked: true });
}));

async function getPublication(id: string) {
  const publication = await prisma.lessonPublication.findFirst({ where: { id, revokedAt: null }, include: { lesson: { select: { currentPublicationId: true } } } });
  // Previous immutable versions remain accessible to pinned sessions until the lesson is withdrawn.
  if (!publication || !publication.lesson.currentPublicationId) throw new ReaderReleaseError(404, 'Published lesson unavailable');
  return { publication, manifest: publication.manifest as unknown as ReaderManifest };
}

async function currentPublications() {
  const lessons = await prisma.lesson.findMany({ where: { currentPublicationId: { not: null } }, orderBy: { createdAt: 'asc' } });
  const publications = await prisma.lessonPublication.findMany({ where: { id: { in: lessons.map(l => l.currentPublicationId!) }, revokedAt: null } });
  return lessons.flatMap(lesson => {
    const publication = publications.find(p => p.id === lesson.currentPublicationId && p.lessonId === lesson.id);
    return publication ? [{ publication, manifest: publication.manifest as unknown as ReaderManifest }] : [];
  });
}

router.get('/learner/lessons', authenticate, run(async (req, res) => {
  const publications = await currentPublications();
  const progress = await prisma.readerProgress.findMany({ where: { userId: req.user!.id } });
  return res.json({ lessons: publications.map(({ publication, manifest }) => ({
    id: manifest.lessonId, publicationId: publication.id, title: manifest.title, description: manifest.description,
    textCount: manifest.texts.length, wordCount: manifest.texts.reduce((n, t) => n + t.occurrences.filter(o => o.learning).length, 0),
    durationSeconds: manifest.texts.reduce((n, t) => n + t.narration.frameCount / t.narration.sampleRate, 0),
    completedTexts: manifest.texts.filter(t => progress.some(p => p.textReleaseId === t.textReleaseId && p.completed)).length,
  })) });
}));

async function manifestResponse(req: AuthenticatedRequest, res: Response, id: string) {
  const { publication, manifest } = await getPublication(id);
  const releaseIds = manifest.texts.map(t => t.textReleaseId);
  const [words, progress] = await Promise.all([
    prisma.readerWordState.findMany({ where: { userId: req.user!.id, textReleaseId: { in: releaseIds } } }),
    prisma.readerProgress.findMany({ where: { userId: req.user!.id, textReleaseId: { in: releaseIds } } }),
  ]);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ publicationId: publication.id, manifest, words, progress });
}

router.get('/learner/lessons/:lessonId/manifest', authenticate, run(async (req, res) => {
  const lesson = await prisma.lesson.findUnique({ where: { id: req.params.lessonId } });
  if (!lesson?.currentPublicationId) throw new ReaderReleaseError(404, 'This lesson has no published text version');
  return manifestResponse(req, res, lesson.currentPublicationId);
}));
router.get('/learner/publications/:publicationId', authenticate, run((req, res) => manifestResponse(req, res, req.params.publicationId)));

router.get('/learner/audio-assets/:assetId/content', authenticate, run(async (req, res) => {
  const { publication } = await getPublication(String(req.query.publicationId ?? ''));
  if (!publication.assetIds.includes(req.params.assetId)) throw new ReaderReleaseError(404, 'Audio unavailable in this publication');
  const asset = await prisma.audioAsset.findUnique({ where: { id: req.params.assetId } });
  return servePrivateAudio(req, res, asset);
}));

const stateBase = z.object({ publicationId: z.string().min(1), textReleaseId: z.string().min(1),
  clientUpdatedAt: z.string().datetime().refine(value => Date.parse(value) <= Date.now() + 300000, 'Client time is too far in the future') });
const wordSchema = stateBase.extend({ occurrenceId: z.string().min(1), status: z.enum(['NEW', 'LEARNING', 'LEARNED']) });
router.put('/learner/word-state', authenticate, run(async (req, res) => {
  const parsed = wordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid word state' });
  const input = parsed.data;
  const { manifest } = await getPublication(input.publicationId);
  const text = manifest.texts.find(t => t.textReleaseId === input.textReleaseId);
  if (!text?.occurrences.some(o => o.id === input.occurrenceId && o.learning)) throw new ReaderReleaseError(404, 'Learning occurrence not found');
  const key = { userId: req.user!.id, textReleaseId: input.textReleaseId, occurrenceId: input.occurrenceId };
  const data = { ...key, publicationId: input.publicationId, status: input.status, clientUpdatedAt: new Date(input.clientUpdatedAt) };
  await prisma.$transaction(async tx => {
    await tx.readerWordState.upsert({ where: { userId_textReleaseId_occurrenceId: key }, create: data, update: {} });
    await tx.readerWordState.updateMany({ where: { ...key, clientUpdatedAt: { lt: data.clientUpdatedAt } }, data });
  });
  return res.json({ word: await prisma.readerWordState.findUnique({ where: { userId_textReleaseId_occurrenceId: key } }) });
}));

const progressSchema = stateBase.extend({ lastSample: z.number().int().nonnegative(), completed: z.boolean() });
router.put('/learner/reader-progress', authenticate, run(async (req, res) => {
  const parsed = progressSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid reading progress' });
  const input = parsed.data;
  const { manifest } = await getPublication(input.publicationId);
  const text = manifest.texts.find(t => t.textReleaseId === input.textReleaseId);
  if (!text || input.lastSample > text.narration.frameCount) throw new ReaderReleaseError(400, 'Progress is outside this text');
  const key = { userId: req.user!.id, textReleaseId: input.textReleaseId };
  const data = { ...key, publicationId: input.publicationId, lastSample: input.lastSample, completed: input.completed,
    clientUpdatedAt: new Date(input.clientUpdatedAt) };
  await prisma.$transaction(async tx => {
    await tx.readerProgress.upsert({ where: { userId_textReleaseId: key }, create: data, update: {} });
    await tx.readerProgress.updateMany({ where: { ...key, clientUpdatedAt: { lt: data.clientUpdatedAt } },
      data: { ...data, completed: input.completed ? true : undefined } });
  });
  return res.json({ progress: await prisma.readerProgress.findUnique({ where: { userId_textReleaseId: key } }) });
}));

router.get('/learner/words', authenticate, run(async (req, res) => {
  const [publications, states] = await Promise.all([currentPublications(), prisma.readerWordState.findMany({ where: { userId: req.user!.id } })]);
  return res.json({ words: publications.flatMap(({ publication, manifest }) => manifest.texts.flatMap(text =>
    text.occurrences.flatMap(occurrence => occurrence.learning ? [{
      publicationId: publication.id, lessonId: manifest.lessonId, lessonTitle: manifest.title, textReleaseId: text.textReleaseId,
      occurrence, sentence: text.sentences.find(s => s.id === occurrence.sentenceId)?.text ?? '',
      status: states.find(s => s.textReleaseId === text.textReleaseId && s.occurrenceId === occurrence.id)?.status ?? 'NEW',
    }] : []))) });
}));

export { router as readerRouter };
