import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Private filesystem storage for text-authoring audio assets, deliberately
 * kept outside `public/` (which is served statically at `/media`). Assets
 * are addressed by opaque storage keys, never client-supplied paths.
 */

export const AUDIO_AUTHORING_ROOT_ENV = 'AUDIO_AUTHORING_STORAGE_ROOT';

function resolveRoot(): string {
  const configured = process.env[AUDIO_AUTHORING_ROOT_ENV];
  return path.resolve(configured ?? path.join(process.cwd(), 'var', 'audio-authoring'));
}

export type AudioAssetKindForStorage = 'NARRATION' | 'WORD_CLIP' | 'LEGACY_REFERENCE';

export interface WriteAudioAssetInput {
  textId: string;
  kind: AudioAssetKindForStorage;
  bytes: Buffer;
}

export interface WriteAudioAssetResult {
  storageKey: string;
  byteLength: number;
  sha256: string;
}

function sanitizeIdSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!sanitized) {
    throw new Error('Cannot derive a safe storage path segment from an empty/unsafe id');
  }
  return sanitized;
}

export async function writeAudioAsset(input: WriteAudioAssetInput): Promise<WriteAudioAssetResult> {
  const root = resolveRoot();
  const dir = path.join(root, sanitizeIdSegment(input.textId), input.kind.toLowerCase());
  await fs.promises.mkdir(dir, { recursive: true });

  const sha256 = crypto.createHash('sha256').update(input.bytes).digest('hex');
  const fileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${sha256.slice(0, 16)}.bin`;
  const finalPath = path.join(dir, fileName);
  const stagingPath = `${finalPath}.staging-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

  const handle = await fs.promises.open(stagingPath, 'w');
  try {
    await handle.writeFile(input.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(stagingPath, finalPath);

  const storageKey = path.relative(root, finalPath).split(path.sep).join('/');
  return { storageKey, byteLength: input.bytes.length, sha256 };
}

/**
 * Resolves an opaque storage key to an absolute filesystem path, rejecting
 * any key that would escape the storage root (path traversal).
 */
export function resolveAssetStorageKey(storageKey: string): string | null {
  const root = resolveRoot();
  const resolved = path.resolve(root, storageKey);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

export interface AssetRange {
  buffer: Buffer;
  totalLength: number;
}

export function readAudioAssetRange(storageKey: string, start: number, endExclusive: number): AssetRange | null {
  const resolved = resolveAssetStorageKey(storageKey);
  if (!resolved || !fs.existsSync(resolved)) {
    return null;
  }
  const stat = fs.statSync(resolved);
  const fd = fs.openSync(resolved, 'r');
  try {
    const clampedEnd = Math.min(endExclusive, stat.size);
    const length = Math.max(0, clampedEnd - start);
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      fs.readSync(fd, buffer, 0, length, start);
    }
    return { buffer, totalLength: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}
