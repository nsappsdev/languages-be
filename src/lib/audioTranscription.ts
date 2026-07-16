import fs from 'fs';
import path from 'path';

import { TranscriptWord } from './lessonTimingAlignment';

export type TimingTranscriptionProvider = 'openai-whisper' | 'dashscope-qwen-filetrans';

export interface AudioTranscriptionResult {
  text: string;
  words: TranscriptWord[];
  audioDurationSeconds?: number;
  provider: TimingTranscriptionProvider;
  warnings?: string[];
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

interface DashScopeSubmitResponse {
  output?: {
    task_id?: string;
    task_status?: string;
  };
  request_id?: string;
  code?: string;
  message?: string;
}

interface DashScopeTaskResponse {
  output?: {
    task_id?: string;
    task_status?: string;
    code?: string;
    message?: string;
    result?: {
      transcription_url?: string;
    };
  };
  usage?: {
    seconds?: number;
  };
  code?: string;
  message?: string;
}

interface DashScopeResultPayload {
  transcripts?: Array<{
    text?: string;
    sentences?: Array<{
      text?: string;
      words?: Array<{
        text?: string;
        begin_time?: number;
        end_time?: number;
        punctuation?: string;
      }>;
    }>;
  }>;
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

const DEFAULT_DASHSCOPE_REGION = 'ap-southeast-1';
const DASHSCOPE_POLL_ATTEMPTS = 20;
const DASHSCOPE_POLL_DELAY_MS = 1500;

export function getTimingTranscriptionProvider(): TimingTranscriptionProvider {
  const configured = process.env.TIMING_TRANSCRIPTION_PROVIDER?.trim();
  if (configured === 'dashscope-qwen-filetrans') {
    return configured;
  }
  return 'openai-whisper';
}

export function buildDashScopeFileUrl(audioUrl: string): string {
  const appBaseUrl = process.env.APP_BASE_URL?.trim();
  if (!appBaseUrl) {
    throw new Error('APP_BASE_URL must point to a publicly reachable HTTPS origin for DashScope file transcription.');
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(appBaseUrl);
  } catch {
    throw new Error('APP_BASE_URL must be a valid publicly reachable URL for DashScope file transcription.');
  }

  if (!isPubliclyReachableHostname(parsedBaseUrl.hostname)) {
    throw new Error('DashScope file transcription requires a publicly reachable APP_BASE_URL; localhost or private network hosts will not work.');
  }

  return new URL(audioUrl, parsedBaseUrl).toString();
}

export async function transcribeAudioWithWordTimestamps({
  audioPath,
  audioUrl,
  prompt,
  provider,
}: {
  audioPath: string;
  audioUrl?: string;
  prompt?: string;
  provider?: TimingTranscriptionProvider;
}): Promise<AudioTranscriptionResult> {
  const selectedProvider = provider ?? getTimingTranscriptionProvider();

  if (selectedProvider === 'dashscope-qwen-filetrans') {
    if (!audioUrl) {
      throw new Error('DashScope file transcription requires the lesson item audioUrl so the provider can fetch a public file URL.');
    }

    return transcribeWithDashScopeQwenFiletrans({
      audioUrl,
    });
  }

  return transcribeWithOpenAiWhisper({ audioPath, prompt });
}

async function transcribeWithOpenAiWhisper({
  audioPath,
  prompt,
}: {
  audioPath: string;
  prompt?: string;
}): Promise<AudioTranscriptionResult> {
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
    provider: 'openai-whisper',
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

async function transcribeWithDashScopeQwenFiletrans({
  audioUrl,
}: {
  audioUrl: string;
}): Promise<AudioTranscriptionResult> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID;
  const region = process.env.DASHSCOPE_REGION?.trim() || DEFAULT_DASHSCOPE_REGION;

  if (!apiKey) {
    throw new Error('DASHSCOPE_API_KEY is not configured');
  }
  if (!workspaceId) {
    throw new Error('DASHSCOPE_WORKSPACE_ID is not configured');
  }

  const fileUrl = buildDashScopeFileUrl(audioUrl);
  const baseUrl = `https://${workspaceId}.${region}.maas.aliyuncs.com/api/v1`;

  const submitResponse = await fetch(`${baseUrl}/services/audio/asr/transcription`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: 'qwen3-asr-flash-filetrans',
      input: {
        file_url: fileUrl,
      },
      parameters: {
        language: 'en',
        enable_itn: false,
        enable_words: true,
      },
    }),
  });

  const submitPayload = (await submitResponse.json()) as DashScopeSubmitResponse;
  if (!submitResponse.ok) {
    throw new Error(
      submitPayload.message ?? submitPayload.code ?? `DashScope transcription submit failed with ${submitResponse.status}`,
    );
  }

  const taskId = submitPayload.output?.task_id;
  if (!taskId) {
    throw new Error('DashScope transcription did not return a task_id.');
  }

  let finalTaskPayload: DashScopeTaskResponse | null = null;

  for (let attempt = 0; attempt < DASHSCOPE_POLL_ATTEMPTS; attempt += 1) {
    const taskResponse = await fetch(`${baseUrl}/tasks/${taskId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    const taskPayload = (await taskResponse.json()) as DashScopeTaskResponse;
    if (!taskResponse.ok) {
      throw new Error(
        taskPayload.message ?? taskPayload.code ?? `DashScope task poll failed with ${taskResponse.status}`,
      );
    }

    const taskStatus = taskPayload.output?.task_status;
    if (taskStatus === 'SUCCEEDED') {
      finalTaskPayload = taskPayload;
      break;
    }

    if (taskStatus === 'FAILED' || taskStatus === 'UNKNOWN') {
      throw new Error(taskPayload.output?.message ?? taskPayload.output?.code ?? `DashScope task ${taskStatus}`);
    }

    if (attempt < DASHSCOPE_POLL_ATTEMPTS - 1) {
      await sleep(DASHSCOPE_POLL_DELAY_MS);
    }
  }

  if (!finalTaskPayload) {
    throw new Error(`DashScope transcription did not complete after ${DASHSCOPE_POLL_ATTEMPTS} polls.`);
  }

  const transcriptionUrl = finalTaskPayload.output?.result?.transcription_url;
  if (!transcriptionUrl) {
    throw new Error('DashScope transcription did not return a transcription_url result.');
  }

  const resultResponse = await fetch(transcriptionUrl, {
    method: 'GET',
  });
  const resultPayload = (await resultResponse.json()) as DashScopeResultPayload;

  if (!resultResponse.ok) {
    throw new Error(`DashScope transcription result fetch failed with ${resultResponse.status}`);
  }

  const firstTranscript = resultPayload.transcripts?.[0];
  const words = (firstTranscript?.sentences ?? [])
    .flatMap((sentence) => sentence.words ?? [])
    .filter(
      (word): word is { text: string; begin_time: number; end_time: number; punctuation?: string } =>
        typeof word.text === 'string' &&
        typeof word.begin_time === 'number' &&
        typeof word.end_time === 'number',
    )
    .map((word) => ({
      word: normalizeDashScopeWord(word.text),
      start: millisecondsToSeconds(word.begin_time),
      end: millisecondsToSeconds(word.end_time),
    }))
    .filter((word) => word.word.length > 0 && word.end > word.start);

  return {
    provider: 'dashscope-qwen-filetrans',
    text: firstTranscript?.text ?? '',
    audioDurationSeconds:
      typeof finalTaskPayload.usage?.seconds === 'number' && Number.isFinite(finalTaskPayload.usage.seconds)
        ? finalTaskPayload.usage.seconds
        : undefined,
    words,
    warnings: words.length ? undefined : ['DashScope returned no usable word-level timestamps.'],
  };
}

function normalizeDashScopeWord(text: string) {
  return text.trim();
}

function millisecondsToSeconds(value: number) {
  return Math.max(0, value) / 1000;
}

function isPubliclyReachableHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return false;
  if (normalized === '127.0.0.1' || normalized === '0.0.0.0' || normalized === '::1') return false;
  if (/^10\./.test(normalized)) return false;
  if (/^192\.168\./.test(normalized)) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)) return false;
  return true;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
