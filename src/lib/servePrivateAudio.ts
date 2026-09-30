import { AudioAsset } from '@prisma/client';
import { Request, Response } from 'express';
import { readAudioAssetRange } from './audioAssetStorage';

export function parseByteRange(header: string | undefined, size: number) {
  if (!header) return { start: 0, end: size, status: 200 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const suffix = !match[1];
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  if (suffix && last <= 0) return null;
  const start = suffix ? Math.max(0, size - last) : first;
  const end = suffix || !match[2] ? size : Math.min(size, last + 1);
  if (start < 0 || start >= size || end <= start) return null;
  return { start, end, status: 206 };
}

export function servePrivateAudio(req: Request, res: Response, asset: AudioAsset | null) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Authorization');
  if (!asset || asset.state !== 'READY') return res.status(404).json({ message: 'Audio unavailable' });
  const range = parseByteRange(req.headers.range, asset.byteLength);
  if (!range) {
    res.setHeader('Content-Range', `bytes */${asset.byteLength}`);
    return res.status(416).end();
  }
  try {
    const stored = readAudioAssetRange(asset.storageKey, range.start, range.end);
    if (!stored || stored.totalLength !== asset.byteLength) return res.status(404).json({ message: 'Audio unavailable' });
    res.status(range.status).set({ 'Content-Type': asset.mimeType, 'Accept-Ranges': 'bytes',
      'Content-Length': String(stored.buffer.length), 'X-Content-Type-Options': 'nosniff' });
    if (range.status === 206) res.setHeader('Content-Range', `bytes ${range.start}-${range.end - 1}/${asset.byteLength}`);
    return res.send(stored.buffer);
  } catch { return res.status(404).json({ message: 'Audio unavailable' }); }
}
