import path from 'path';

export const AUDIO_UPLOAD_DIR = path.resolve(process.cwd(), 'public', 'audio');

export function resolveStoredAudioPath(audioUrl: string) {
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
