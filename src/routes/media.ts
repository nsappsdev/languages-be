import fs from 'fs';
import path from 'path';
import { Response, Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';

const router = Router();

const AUDIO_UPLOAD_DIR = path.resolve(process.cwd(), 'public', 'audio');
const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
]);
const MIME_EXTENSION_MAP: Record<string, string> = {
  'audio/mp3': '.mp3',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
};

type UploadedAudioRequest = AuthenticatedRequest & {
  file?: Express.Multer.File;
  body: {
    lessonItemId?: string;
  };
};

const deleteAudioSchema = z.object({
  lessonItemId: z.string().trim().min(1).optional(),
  audioUrl: z.string().trim().min(1),
});

function ensureUploadDir() {
  fs.mkdirSync(AUDIO_UPLOAD_DIR, { recursive: true });
}

function requireAdmin(req: AuthenticatedRequest, res: Response) {
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

function sanitizeFileStem(value: string) {
  const sanitized = value
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

  return sanitized || 'audio';
}

function resolveFileExtension(originalName: string, mimeType: string) {
  const directExtension = path.extname(originalName).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(directExtension)) {
    return directExtension;
  }

  const mappedExtension = MIME_EXTENSION_MAP[mimeType.toLowerCase()];
  if (mappedExtension && ALLOWED_EXTENSIONS.has(mappedExtension)) {
    return mappedExtension;
  }

  return null;
}

function resolveStoredAudioPath(audioUrl: string) {
  const mediaPrefix = '/media/audio/';
  if (!audioUrl.startsWith(mediaPrefix)) {
    return null;
  }

  const encodedFileName = audioUrl.slice(mediaPrefix.length);
  if (!encodedFileName) {
    return null;
  }

  const decodedFileName = decodeURIComponent(encodedFileName);
  if (decodedFileName !== path.basename(decodedFileName)) {
    return null;
  }

  return path.join(AUDIO_UPLOAD_DIR, decodedFileName);
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    ensureUploadDir();
    callback(null, AUDIO_UPLOAD_DIR);
  },
  filename: (_req, file, callback) => {
    const extension = resolveFileExtension(file.originalname, file.mimetype) ?? '.bin';
    const stem = sanitizeFileStem(path.basename(file.originalname, path.extname(file.originalname)));
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    callback(null, `${stem}-${uniqueSuffix}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_AUDIO_UPLOAD_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    const extension = resolveFileExtension(file.originalname, file.mimetype);
    if (!file.mimetype.startsWith('audio/') && !extension) {
      callback(new Error('Only MP3 and WAV audio files are allowed'));
      return;
    }

    if (!extension) {
      callback(new Error('Only MP3 and WAV audio files are allowed'));
      return;
    }

    callback(null, true);
  },
});

router.post('/media/audio', authenticate, (req: AuthenticatedRequest, res, next) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  upload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({
        message: `Audio upload exceeds ${Math.round(MAX_AUDIO_UPLOAD_BYTES / (1024 * 1024))} MB`,
      });
      return;
    }

    res.status(400).json({
      message: error instanceof Error ? error.message : 'Failed to upload audio file',
    });
  });
});

router.post('/media/audio', (req: UploadedAudioRequest, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Audio file is required' });
  }

  const audioUrl = `/media/audio/${encodeURIComponent(req.file.filename)}`;

  const finalize = async () => {
    const lessonItemId = req.body.lessonItemId?.trim();
    if (lessonItemId) {
      await prisma.lessonItem.updateMany({
        where: { id: lessonItemId },
        data: { audioUrl },
      });
    }

    return res.status(201).json({
      file: {
        audioUrl,
        fileName: req.file!.filename,
        originalName: req.file!.originalname,
        mimeType: req.file!.mimetype,
        size: req.file!.size,
      },
    });
  };

  return void finalize();
});

router.delete('/media/audio', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  const parsed = deleteAudioSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const lessonItemId = parsed.data.lessonItemId?.trim();
  if (lessonItemId) {
    await prisma.lessonItem.updateMany({
      where: { id: lessonItemId },
      data: { audioUrl: '' },
    });
  }

  const targetPath = resolveStoredAudioPath(parsed.data.audioUrl);
  if (!targetPath) {
    return res.status(400).json({ message: 'Invalid audioUrl' });
  }

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }

  return res.status(204).send();
});

export { router as mediaRouter };
