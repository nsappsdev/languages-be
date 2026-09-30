import { encodeWav } from '../../../lib/pcmWav';

/**
 * Installs a fetch shim that intercepts only calls to the real ElevenLabs
 * API host and returns a small deterministic synthetic response built from
 * the exact requested text (so the alignment mapper's exact-reconstruction
 * check passes). Any other URL (i.e. the test's own calls to the local
 * server under test) is passed through to the real fetch. This is
 * explicitly a synthetic test fixture, not a captured provider response.
 */
export function installFakeElevenLabsFetch() {
  const realFetch = global.fetch;
  const shim = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('api.elevenlabs.io')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text: string };
      const text = body.text ?? '';
      const characters = Array.from(text);
      const perCharSeconds = 0.05;
      const character_start_times_seconds = characters.map((_, i) => i * perCharSeconds);
      const character_end_times_seconds = characters.map((_, i) => (i + 1) * perCharSeconds);
      const durationSeconds = characters.length * perCharSeconds;
      const sampleRate = 24000;
      const frameCount = Math.max(1, Math.round(durationSeconds * sampleRate));
      const samples = new Int16Array(frameCount);
      for (let i = 0; i < frameCount; i += 1) {
        samples[i] = ((i * 37) % 2000) - 1000;
      }
      const wav = encodeWav({ sampleRate, channels: 1, bitsPerSample: 16, samples });
      const responseBody = {
        audio_base64: wav.toString('base64'),
        alignment: { characters, character_start_times_seconds, character_end_times_seconds },
        normalized_alignment: null,
      };
      return new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input as any, init);
  }) as typeof fetch;

  global.fetch = shim;
  return () => {
    global.fetch = realFetch;
  };
}
