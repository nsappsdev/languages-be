import { Response, Router } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';
import { readAudioAssetRange } from '../lib/audioAssetStorage';

const router = Router();

function requireAdmin(req: AuthenticatedRequest, res: Response): boolean {
  if (!req.user) {
    res.status(401).json({ message: 'Unauthorized' });
    return false;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ message: 'Forbidden' });
    return false;
  }
  return true;
}

/**
 * Streams a private authoring audio asset. Never exposed via the public
 * `/media` static route; requires the same bearer auth as every other admin
 * endpoint and resolves only opaque asset IDs, never client-supplied paths.
 */
router.get('/admin/audio-assets/:assetId/content', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;

  const asset = await prisma.audioAsset.findUnique({ where: { id: req.params.assetId } });
  if (!asset || asset.state !== 'READY') {
    return res.status(404).json({ message: 'Audio asset not available' });
  }

  const totalLength = asset.byteLength;
  const rangeHeader = req.headers.range;
  let start = 0;
  let endExclusive = totalLength;
  let status = 200;

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match || (!match[1] && !match[2])) {
      res.setHeader('Content-Range', `bytes */${totalLength}`);
      return res.status(416).json({ message: 'Invalid Range header' });
    }
    const rangeStart = match[1] ? parseInt(match[1], 10) : 0;
    const rangeEnd = match[2] ? parseInt(match[2], 10) : totalLength - 1;
    if (Number.isNaN(rangeStart) || Number.isNaN(rangeEnd) || rangeStart > rangeEnd || rangeStart < 0 || rangeEnd >= totalLength) {
      res.setHeader('Content-Range', `bytes */${totalLength}`);
      return res.status(416).json({ message: 'Range not satisfiable' });
    }
    start = rangeStart;
    endExclusive = rangeEnd + 1;
    status = 206;
  }

  const range = readAudioAssetRange(asset.storageKey, start, endExclusive);
  if (!range) {
    return res.status(404).json({ message: 'Audio asset bytes are missing from storage' });
  }

  res.status(status);
  res.setHeader('Content-Type', asset.mimeType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', String(range.buffer.length));
  if (status === 206) {
    res.setHeader('Content-Range', `bytes ${start}-${endExclusive - 1}/${totalLength}`);
  }
  return res.send(range.buffer);
});

export { router as adminAudioAssetsRouter };
