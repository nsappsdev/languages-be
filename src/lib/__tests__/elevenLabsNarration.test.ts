import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { generateNarration, type ElevenLabsFetch } from '../elevenLabsNarration';
import { encodeWav } from '../pcmWav';

function fixtureWav() {
  return encodeWav({ sampleRate: 24000, channels: 1, bitsPerSample: 16, samples: Int16Array.from([1, 2, 3, 4]) });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('elevenLabsNarration adapter', () => {
  it('refuses to call the provider when no API key is configured', async () => {
    let called = false;
    const fetchImpl: ElevenLabsFetch = async () => {
      called = true;
      throw new Error('should not be called');
    };
    await assert.rejects(
      () =>
        generateNarration(
          { text: 'Hello world', voiceId: 'voice-1' },
          { apiKey: '', fetchImpl },
        ),
      /AUDIO_GENERATION_NOT_CONFIGURED/,
    );
    assert.equal(called, false);
  });

  it('sends the exact configured model/voice/output format and explicit text, not a partial payload', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl: ElevenLabsFetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      const audioB64 = fixtureWav().toString('base64');
      return jsonResponse(200, {
        audio_base64: audioB64,
        alignment: { characters: ['H'], character_start_times_seconds: [0], character_end_times_seconds: [0.1] },
        normalized_alignment: null,
      });
    };

    const result = await generateNarration(
      { text: 'Hello world', voiceId: 'voice-1' },
      { apiKey: 'test-key', fetchImpl },
    );

    assert.match(capturedUrl, /\/v1\/text-to-speech\/voice-1\/with-timestamps/);
    assert.match(capturedUrl, /output_format=wav_24000/);
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get('xi-api-key'), 'test-key');
    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.text, 'Hello world');
    assert.equal(body.model_id, 'eleven_multilingual_v2');
    assert.equal(result.alignment?.characters.length, 1);
    assert.equal(result.audio.frameCount, 4);
  });

  it('rejects empty/whitespace-only text before dispatch', async () => {
    const fetchImpl: ElevenLabsFetch = async () => {
      throw new Error('should not be called');
    };
    await assert.rejects(
      () => generateNarration({ text: '   ', voiceId: 'voice-1' }, { apiKey: 'k', fetchImpl }),
      /empty/i,
    );
  });

  it('rejects text over the configured application character limit', async () => {
    const fetchImpl: ElevenLabsFetch = async () => {
      throw new Error('should not be called');
    };
    const longText = 'a'.repeat(5001);
    await assert.rejects(
      () => generateNarration({ text: longText, voiceId: 'voice-1' }, { apiKey: 'k', fetchImpl }),
      /limit/i,
    );
  });

  it('surfaces a null alignment as an explicit result field rather than throwing', async () => {
    const fetchImpl: ElevenLabsFetch = async () =>
      jsonResponse(200, { audio_base64: fixtureWav().toString('base64'), alignment: null, normalized_alignment: null });
    const result = await generateNarration({ text: 'Hi', voiceId: 'voice-1' }, { apiKey: 'k', fetchImpl });
    assert.equal(result.alignment, null);
  });

  it('classifies a 401 provider response as a configuration error, not retryable', async () => {
    const fetchImpl: ElevenLabsFetch = async () => jsonResponse(401, { detail: 'invalid key' });
    await assert.rejects(
      () => generateNarration({ text: 'Hi', voiceId: 'voice-1' }, { apiKey: 'bad', fetchImpl }),
      (error: any) => {
        assert.equal(error.code, 'PROVIDER_AUTH_FAILED');
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });

  it('classifies a 429 provider response as retryable', async () => {
    const fetchImpl: ElevenLabsFetch = async () => jsonResponse(429, { detail: 'rate limited' });
    await assert.rejects(
      () => generateNarration({ text: 'Hi', voiceId: 'voice-1' }, { apiKey: 'k', fetchImpl }),
      (error: any) => {
        assert.equal(error.code, 'PROVIDER_RATE_LIMITED');
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });

  it('rejects a malformed (non-WAV) audio_base64 payload rather than returning garbage', async () => {
    const fetchImpl: ElevenLabsFetch = async () =>
      jsonResponse(200, { audio_base64: Buffer.from('not a wav').toString('base64'), alignment: null, normalized_alignment: null });
    await assert.rejects(() => generateNarration({ text: 'Hi', voiceId: 'voice-1' }, { apiKey: 'k', fetchImpl }), /RIFF/);
  });

  it('treats a network/timeout failure as an unknown provider outcome', async () => {
    const fetchImpl: ElevenLabsFetch = async () => {
      throw new Error('fetch failed: ECONNRESET');
    };
    await assert.rejects(
      () => generateNarration({ text: 'Hi', voiceId: 'voice-1' }, { apiKey: 'k', fetchImpl }),
      (error: any) => {
        assert.equal(error.code, 'PROVIDER_UNKNOWN_OUTCOME');
        return true;
      },
    );
  });
});
