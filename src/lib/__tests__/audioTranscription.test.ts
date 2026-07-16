import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  buildDashScopeFileUrl,
  getTimingTranscriptionProvider,
  transcribeAudioWithWordTimestamps,
} from '../audioTranscription';

const originalFetch = global.fetch;
const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
  DASHSCOPE_WORKSPACE_ID: process.env.DASHSCOPE_WORKSPACE_ID,
  DASHSCOPE_REGION: process.env.DASHSCOPE_REGION,
  TIMING_TRANSCRIPTION_PROVIDER: process.env.TIMING_TRANSCRIPTION_PROVIDER,
  APP_BASE_URL: process.env.APP_BASE_URL,
};

describe('audio transcription provider selection', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('defaults to openai-whisper when no provider override is configured', () => {
    delete process.env.TIMING_TRANSCRIPTION_PROVIDER;

    assert.equal(getTimingTranscriptionProvider(), 'openai-whisper');
  });

  it('rejects localhost app URLs for dashscope file transcription', () => {
    process.env.APP_BASE_URL = 'http://localhost:4000';

    assert.throws(
      () => buildDashScopeFileUrl('/media/audio/test.mp3'),
      /publicly reachable APP_BASE_URL/i,
    );
  });

  it('transcribes uploaded audio through dashscope file transcription and normalizes word timestamps', async () => {
    process.env.TIMING_TRANSCRIPTION_PROVIDER = 'dashscope-qwen-filetrans';
    process.env.DASHSCOPE_API_KEY = 'dashscope-test-key';
    process.env.DASHSCOPE_WORKSPACE_ID = 'workspace-123';
    process.env.DASHSCOPE_REGION = 'ap-southeast-1';
    process.env.APP_BASE_URL = 'https://api.example.com';

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = (async (url, init) => {
      fetchCalls.push({ url: String(url), init });

      if (String(url).includes('/services/audio/asr/transcription')) {
        return {
          ok: true,
          json: async () => ({
            output: {
              task_id: 'task-123',
              task_status: 'PENDING',
            },
          }),
        } as Response;
      }

      if (String(url).includes('/api/v1/tasks/task-123')) {
        return {
          ok: true,
          json: async () => ({
            output: {
              task_id: 'task-123',
              task_status: 'SUCCEEDED',
              result: {
                transcription_url: 'https://dashscope-result.example.com/result.json',
              },
            },
            usage: {
              seconds: 3,
            },
          }),
        } as Response;
      }

      if (String(url) === 'https://dashscope-result.example.com/result.json') {
        return {
          ok: true,
          json: async () => ({
            transcripts: [
              {
                text: 'Hello world.',
                sentences: [
                  {
                    words: [
                      { text: 'Hello ', begin_time: 120, end_time: 480, punctuation: '' },
                      { text: 'world', begin_time: 500, end_time: 920, punctuation: '.' },
                    ],
                  },
                ],
              },
            ],
          }),
        } as Response;
      }

      throw new Error(`Unexpected fetch call: ${String(url)}`);
    }) as typeof fetch;

    const result = await transcribeAudioWithWordTimestamps({
      audioPath: '/tmp/ignored.mp3',
      audioUrl: '/media/audio/test.mp3',
      prompt: 'Hello world.',
    });

    assert.equal(result.provider, 'dashscope-qwen-filetrans');
    assert.equal(result.text, 'Hello world.');
    assert.equal(result.audioDurationSeconds, 3);
    assert.deepEqual(result.words, [
      { word: 'Hello', start: 0.12, end: 0.48 },
      { word: 'world', start: 0.5, end: 0.92 },
    ]);

    assert.equal(fetchCalls.length, 3);
    assert.equal(fetchCalls[0].url, 'https://workspace-123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/asr/transcription');
    assert.equal(fetchCalls[1].url, 'https://workspace-123.ap-southeast-1.maas.aliyuncs.com/api/v1/tasks/task-123');
    assert.equal(fetchCalls[2].url, 'https://dashscope-result.example.com/result.json');

    const submitBody = JSON.parse(String(fetchCalls[0].init?.body)) as {
      input: { file_url: string };
      parameters: { enable_words: boolean; language: string; enable_itn: boolean };
    };
    assert.equal(submitBody.input.file_url, 'https://api.example.com/media/audio/test.mp3');
    assert.equal(submitBody.parameters.enable_words, true);
    assert.equal(submitBody.parameters.language, 'en');
    assert.equal(submitBody.parameters.enable_itn, false);
  });
});
