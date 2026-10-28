import { Response, Router } from 'express';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';
import { fontBytes, fontDto, inspectFont, lockSettings, MAX_FONT_BYTES, storeFont } from '../lib/readerFonts';
import { ReaderReleaseError } from '../lib/readerRelease';

const router = Router();
const run = (handler: (req: AuthenticatedRequest, res: Response) => Promise<unknown>, admin = true) => (req: AuthenticatedRequest, res: Response) => {
  if (admin && req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  void handler(req, res).catch(error => {
    if (error instanceof ReaderReleaseError) return res.status(error.status).json({ message: error.message });
    console.error('Reader font request failed', error);
    return res.status(500).json({ message: 'Unable to manage reader fonts' });
  });
};
router.get('/admin/reader-fonts', authenticate, run(async (_req, res) => {
  const [fonts, settings] = await Promise.all([prisma.readerFont.findMany({ orderBy: { createdAt: 'desc' } }), prisma.appSettings.findUnique({ where: { id: 'global' } })]);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ fonts: fonts.map(font => ({ ...fontDto(font), inUse: [settings?.mainTextFontId, settings?.translationFontId].includes(font.id) })) });
}));
router.post('/admin/reader-fonts', authenticate, run(async (req, res) => {
  const parsed = z.object({ label: z.string().trim().min(1).max(100), fileName: z.string().min(1).max(200),
    base64: z.string().min(1).max(Math.ceil(MAX_FONT_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict().safeParse(req.body);
  if (!parsed.success) throw new ReaderReleaseError(400, 'Provide a label and a TTF/OTF font up to 3 MB.');
  const bytes = Buffer.from(parsed.data.base64, 'base64');
  const metadata = inspectFont(bytes, parsed.data.fileName);
  await storeFont(metadata, bytes);
  const font = await prisma.readerFont.upsert({ where: { sha256: metadata.sha256 }, update: {}, create: { label: parsed.data.label, ...metadata } });
  return res.status(201).json({ font: fontDto(font) });
}));
router.patch('/admin/reader-fonts/:fontId', authenticate, run(async (req, res) => {
  const parsed = z.object({ label: z.string().trim().min(1).max(100).optional(), archived: z.boolean().optional() }).strict().safeParse(req.body);
  if (!parsed.success) throw new ReaderReleaseError(400, 'Provide a font label or archive choice.');
  const font = await prisma.$transaction(async tx => {
    const settings = await lockSettings(tx);
    const font = await tx.readerFont.findUnique({ where: { id: req.params.fontId } });
    if (!font) throw new ReaderReleaseError(404, 'Font not found');
    if (parsed.data.archived && [settings.mainTextFontId, settings.translationFontId].includes(font.id))
      throw new ReaderReleaseError(409, 'Choose and save a replacement reader font before archiving this font.');
    return tx.readerFont.update({ where: { id: font.id }, data: { label: parsed.data.label,
      ...(parsed.data.archived === undefined ? {} : { archivedAt: parsed.data.archived ? new Date() : null }) } });
  });
  return res.json({ font: fontDto(font) });
}));
router.get('/reader-fonts/:fontId/content', authenticate, run(async (req, res) => {
  const font = await prisma.readerFont.findUnique({ where: { id: req.params.fontId } });
  const bytes = font && fontBytes(font);
  if (!font || !bytes) throw new ReaderReleaseError(404, 'Reader font unavailable');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('ETag', `"${font.sha256}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.header('If-None-Match') === `"${font.sha256}"`) return res.status(304).end();
  return res.type(font.format === 'otf' ? 'font/otf' : 'font/ttf').send(bytes);
}, false));
export { router as readerFontsRouter };
