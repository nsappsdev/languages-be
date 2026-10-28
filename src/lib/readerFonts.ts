import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { create } from 'fontkit';
import { AppSettings, Prisma, ReaderFont } from '@prisma/client';
import { ReaderReleaseError } from './readerRelease';

export const MAX_FONT_BYTES = 3 * 1024 * 1024;
const root = () => path.resolve(process.env.READER_FONT_STORAGE_ROOT ?? path.join(process.cwd(), 'var', 'reader-fonts'));
const fontPath = (font: Pick<ReaderFont, 'sha256' | 'format'>) => {
  if (!/^[a-f0-9]{64}$/.test(font.sha256) || !['ttf', 'otf'].includes(font.format)) throw new Error('Invalid font storage identity');
  return path.join(root(), `${font.sha256}.${font.format}`);
};

export function inspectFont(bytes: Buffer, fileName: string) {
  const magic = bytes.subarray(0, 4).toString('hex');
  const format = magic === '4f54544f' ? 'otf' : ['00010000', '74727565'].includes(magic) ? 'ttf' : null;
  if (!format || !new RegExp(`\\.${format}$`, 'i').test(fileName) || bytes.length > MAX_FONT_BYTES || bytes.length < 128)
    throw new ReaderReleaseError(400, 'Upload a valid TTF or OTF font, up to 3 MB.');
  try {
    const font = create(bytes);
    if (!font.postscriptName || !font.familyName || !font.unitsPerEm || font.numGlyphs < 2) throw new Error('Invalid font metadata');
    const english = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const armenian = 'ԱԲԳԴԵԶԷԸԹԺԻԼԽԾԿՀՁՂՃՄՅՆՇՈՉՊՋՌՍՎՏՐՑՒՓՔՕՖաբգդեզէըթժիլխծկհձղճմյնշոչպջռսվտրցւփքօֆև';
    const supports = (text: string) => [...text].every(letter => font.hasGlyphForCodePoint(letter.codePointAt(0)!));
    const supportsEnglish = supports(english), supportsArmenian = supports(armenian);
    if (!supportsEnglish && !supportsArmenian) throw new Error('Missing alphabet');
    // Exercise outline parsing too; name/cmap tables alone are insufficient.
    for (const letter of supportsArmenian ? 'Աբգև' : 'Abgy') void font.glyphForCodePoint(letter.codePointAt(0)!).path;
    return { format, familyName: font.familyName.slice(0, 160), subfamilyName: (font.subfamilyName || 'Regular').slice(0, 100),
      postscriptName: font.postscriptName.slice(0, 160), supportsEnglish, supportsArmenian,
      byteLength: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } catch {
    throw new ReaderReleaseError(400, 'This font cannot be used. Choose a valid font with English or Armenian letters.');
  }
}

export async function storeFont(font: Pick<ReaderFont, 'sha256' | 'format'>, bytes: Buffer) {
  await fs.promises.mkdir(root(), { recursive: true });
  const temporary = `${fontPath(font)}.${crypto.randomUUID()}.partial`;
  try { await fs.promises.writeFile(temporary, bytes, { flag: 'wx' }); await fs.promises.rename(temporary, fontPath(font)); }
  finally { await fs.promises.rm(temporary, { force: true }); }
}
export function fontBytes(font: ReaderFont): Buffer | null {
  try {
    const bytes = fs.readFileSync(fontPath(font));
    return bytes.length === font.byteLength && crypto.createHash('sha256').update(bytes).digest('hex') === font.sha256 ? bytes : null;
  } catch { return null; }
}
export function fontDto(font: ReaderFont) {
  return { id: font.id, label: font.label, familyName: font.familyName, subfamilyName: font.subfamilyName,
    format: font.format, sha256: font.sha256, byteLength: font.byteLength,
    supportsEnglish: font.supportsEnglish, supportsArmenian: font.supportsArmenian,
    archivedAt: font.archivedAt, available: !!fontBytes(font) };
}
export async function lockSettings(tx: Prisma.TransactionClient) {
  await tx.appSettings.upsert({ where: { id: 'global' }, create: { id: 'global' }, update: {} });
  await tx.$queryRaw`SELECT id FROM "AppSettings" WHERE id = 'global' FOR UPDATE`;
  return tx.appSettings.findUniqueOrThrow({ where: { id: 'global' } });
}
export async function settingsDto(db: Prisma.TransactionClient, settings: AppSettings) {
  const fonts = await db.readerFont.findMany({ where: { id: { in: [settings.mainTextFontId, settings.translationFontId].filter((id): id is string => !!id) } } });
  const find = (id: string | null) => { const font = fonts.find(f => f.id === id); return font ? fontDto(font) : null; };
  return { ...settings, readerFonts: { mainText: find(settings.mainTextFontId), translation: find(settings.translationFontId) } };
}
