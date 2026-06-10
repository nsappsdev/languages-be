import fs from 'fs';
import path from 'path';

import { TranscriptWord } from './lessonTimingAlignment';

export interface OpenAITranscriptionResult {
  text: string;
  words: TranscriptWord[];
  audioDurationSeconds?: number;
}

interface OpenAIVerboseTranscriptionResponse {
  text?: string;
  duration?: number;
  words?: Array<{
    word?: string;
    start?: number;
    end?: number;
  }>;
  error?: {
    message?: string;
  };
}

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.mpeg': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

export async function transcribeAudioWithWordTimestamps({
  audioPath,
  prompt,
}: {
  audioPath: string;
  prompt?: string;
}): Promise<OpenAITranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const extension = path.extname(audioPath).toLowerCase();
  const mimeType = MIME_TYPES_BY_EXTENSION[extension] ?? 'application/octet-stream';
  const fileBuffer = await fs.promises.readFile(audioPath);
  const formData = new FormData();

  formData.append('file', new Blob([new Uint8Array(fileBuffer)], { type: mimeType }), path.basename(audioPath));
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'word');
  formData.append('language', 'en');
  if (prompt?.trim()) {
    formData.append('prompt', prompt.trim().slice(0, 1200));
  }

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });
  const payload = (await response.json()) as OpenAIVerboseTranscriptionResponse;

  if (!response.ok) {
    throw new Error(payload.error?.message ?? `OpenAI transcription failed with ${response.status}`);
  }

  return {
    text: payload.text ?? '',
    audioDurationSeconds:
      typeof payload.duration === 'number' && Number.isFinite(payload.duration)
        ? payload.duration
        : undefined,
    words: (payload.words ?? [])
      .filter(
        (word): word is { word: string; start: number; end: number } =>
          typeof word.word === 'string' &&
          typeof word.start === 'number' &&
          typeof word.end === 'number',
      )
      .map((word) => ({
        word: word.word,
        start: word.start,
        end: word.end,
      })),
  };
}
