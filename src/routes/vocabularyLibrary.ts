import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';
import { ReaderReleaseError } from '../lib/readerRelease';
import { normalizeVocabulary, setVocabularyPreference, vocabularyDetail } from '../lib/vocabularyLibrary';

const router = Router();
const run = (handler: (req: AuthenticatedRequest, res: Response) => Promise<unknown>) => (req: AuthenticatedRequest, res: Response) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  void handler(req, res).catch(error => {
    if (error instanceof ReaderReleaseError) return res.status(error.status).json({ message: error.message });
    return res.status(500).json({ message: 'Unable to load the vocabulary library' });
  });
};

router.get('/admin/vocabulary', authenticate, run(async (req, res) => {
  const parsed = z.object({ q: z.string().max(200).default(''), page: z.coerce.number().int().min(1).max(100000).default(1) }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid vocabulary search' });
  const q = normalizeVocabulary(parsed.data.q), page = parsed.data.page, pageSize = 25;
  const where = q ? { OR: [{ normalizedText: { contains: q } }, { meanings: { some: { normalizedTranslation: { contains: q } } } }] } : {};
  const [total, terms] = await prisma.$transaction([
    prisma.vocabularyTerm.count({ where }),
    prisma.vocabularyTerm.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: [{ normalizedText: 'asc' }, { id: 'asc' }],
      include: { meanings: { select: { translation: true, _count: { select: { recordings: true } } }, orderBy: { translation: 'asc' } } } }),
  ]);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ page, pageSize, total, terms: terms.map(t => ({ id: t.id, text: t.displayText, language: t.language,
    translations: t.meanings.map(m => m.translation), recordingCount: t.meanings.reduce((sum, m) => sum + m._count.recordings, 0) })) });
}));

router.get('/admin/vocabulary/:termId', authenticate, run(async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(await vocabularyDetail(prisma, req.params.termId));
}));

router.put('/admin/vocabulary/meanings/:meaningId/preference', authenticate, run(async (req, res) => {
  const parsed = z.object({ voiceId: z.string().min(1).max(200), recordingId: z.string().min(1).nullable(), expectedRecordingId: z.string().min(1).nullable() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Choose a recording and its voice' });
  await setVocabularyPreference(prisma, { ...parsed.data, meaningId: req.params.meaningId, actorId: req.user!.id });
  return res.json({ saved: true });
}));

export { router as vocabularyLibraryRouter };
