import { Response, Router } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';
import { servePrivateAudio } from '../lib/servePrivateAudio';

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
  return servePrivateAudio(req, res, asset);
});

export { router as adminAudioAssetsRouter };
