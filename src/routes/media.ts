import fs from 'fs';
import path from 'path';
import { Response, Router } from 'express';
import multer from 'multer';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';

const router = Router();

const AUDIO_UPLOAD_DIR = path.resolve(process.cwd(), 'public', 'audio');
const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  '.aac',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.wav',
  '.webm',
]);
const MIME_EXTENSION_MAP: Record<string, string> = {
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/webm': '.webm',
  'audio/x-m4a': '.m4a',
  'audio/x-wav': '.wav',
};

type UploadedAudioRequest = AuthenticatedRequest & {
  file?: Express.Multer.File;
};

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
      callback(new Error('Only audio files are allowed'));
      return;
    }

    if (!extension) {
      callback(new Error('Unsupported audio file type'));
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

  return res.status(201).json({
    file: {
      audioUrl: `/media/audio/${encodeURIComponent(req.file.filename)}`,
      fileName: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
    },
  });
});

export { router as mediaRouter };
