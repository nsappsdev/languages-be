import { config } from '../config';
import { ElevenLabsCharacterAlignment } from './textOccurrenceAlignment';

/** A repair request consumes existing audio; this module cannot synthesize speech. */
export async function checkAlignmentBudget(durationSeconds: number) {
  const fraction = config.elevenLabs.alignmentMaxUsageFraction;
  if (!config.elevenLabs.apiKey || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1)
    throw new Error('Timing repair is not configured. The saved recording is unchanged.');
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 300)
    throw new Error('Automatic timing repair supports recordings up to five minutes. Review this recording separately.');
  const response = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': config.elevenLabs.apiKey }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Unable to verify ElevenLabs usage. No timing request was sent.');
  const usage = await response.json() as { character_count?: number; character_limit?: number };
  // Conservative headroom above the documented speech-to-text rate. Never enable overages.
  const reserve = Math.max(1000, Math.ceil(durationSeconds * 10));
  if (!Number.isFinite(usage.character_count) || !Number.isFinite(usage.character_limit) || usage.character_count! < 0 ||
      usage.character_limit! <= 0 || usage.character_count! + reserve > Math.floor(usage.character_limit! * fraction))
    throw new Error('Timing repair paused at the configured ElevenLabs usage limit. The saved recording is unchanged.');
  return { used: usage.character_count!, limit: usage.character_limit!, reserve };
}

export async function alignExistingAudio(bytes: Buffer, text: string): Promise<unknown> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'sentence.wav');
  form.append('text', text);
  const response = await fetch('https://api.elevenlabs.io/v1/forced-alignment', {
    method: 'POST', headers: { 'xi-api-key': config.elevenLabs.apiKey }, body: form, signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Timing repair returned ${response.status}. The recording is saved; no automatic retry will be made.`);
  return response.json();
}

export function forcedAlignmentCharacters(payload: unknown): ElevenLabsCharacterAlignment {
  const result = payload as { characters?: Array<{ text: string; start: number; end: number }>; loss?: number; words?: Array<{loss?: number}> } | null;
  // Loss is an uncalibrated model score, not a 0..1 confidence probability.
  // Preserve it for review; accept timings only after exact text/word/bounds checks.
  if (!result || !Number.isFinite(result.loss) || !Array.isArray(result.words) || !result.words.length ||
      result.words.some(w => !w || !Number.isFinite(w.loss)))
    throw new Error('The alignment provider returned incomplete timing data. The recording is unchanged.');
  if (!Array.isArray(result.characters) || result.characters.some(c => !c || typeof c.text !== 'string'))
    throw new Error('The alignment provider returned malformed timings. The recording is unchanged.');
  return { characters: result.characters.map(c => c.text), character_start_times_seconds: result.characters.map(c => c.start),
    character_end_times_seconds: result.characters.map(c => c.end) };
}
