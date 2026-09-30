import { decodeWav, DecodedWav } from './pcmWav';

/**
 * Injectable ElevenLabs timestamped text-to-speech adapter.
 *
 * Endpoint/response shape confirmed from official docs at implementation
 * time (see plan §3, evidence E1/E2/E5):
 *   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps
 *   Headers: xi-api-key
 *   Body: { text, model_id, voice_settings?, apply_text_normalization }
 *   Query: output_format
 *   Response: { audio_base64, alignment: {characters,character_start_times_seconds,
 *               character_end_times_seconds} | null, normalized_alignment: same | null }
 * `language_code` is documented as unsupported for eleven_multilingual_v2 and is
 * intentionally never sent. No SDK is used; only the documented HTTP contract.
 */

export type ElevenLabsFetch = (url: string, init?: RequestInit) => Promise<Response>;

export const ELEVEN_LABS_MODEL = 'eleven_multilingual_v2';
export const ELEVEN_LABS_OUTPUT_FORMAT = 'wav_24000';
export const MAX_NARRATION_CHARACTERS = 5000;

export interface NarrationCharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface GenerateNarrationRequest {
  text: string;
  voiceId: string;
  voiceSettings?: {
    stability?: number;
    similarityBoost?: number;
    style?: number;
    useSpeakerBoost?: boolean;
    speed?: number;
  };
}

export interface GenerateNarrationOptions {
  apiKey: string;
  fetchImpl?: ElevenLabsFetch;
  timeoutMs?: number;
}

export interface GenerateNarrationResult {
  audio: DecodedWav;
  alignment: NarrationCharacterAlignment | null;
  normalizedAlignment: NarrationCharacterAlignment | null;
}

export type ProviderErrorCode =
  | 'AUDIO_GENERATION_NOT_CONFIGURED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_REQUEST_FAILED'
  | 'PROVIDER_UNKNOWN_OUTCOME'
  | 'INVALID_NARRATION_TEXT';

export class ProviderError extends Error {
  code: ProviderErrorCode;
  retryable: boolean;
  possibleCharge: boolean;

  constructor(code: ProviderErrorCode, message: string, retryable: boolean, possibleCharge = false) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    this.possibleCharge = possibleCharge;
  }
}

const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
  speed: 1,
};

export async function generateNarration(
  request: GenerateNarrationRequest,
  options: GenerateNarrationOptions,
): Promise<GenerateNarrationResult> {
  if (!options.apiKey) {
    throw new ProviderError(
      'AUDIO_GENERATION_NOT_CONFIGURED',
      'AUDIO_GENERATION_NOT_CONFIGURED: ELEVENLABS_API_KEY is not configured on the server.',
      false,
    );
  }
  if (!request.text.trim()) {
    throw new ProviderError('INVALID_NARRATION_TEXT', 'Narration text must not be empty or whitespace-only.', false);
  }
  if (request.text.length > MAX_NARRATION_CHARACTERS) {
    throw new ProviderError(
      'INVALID_NARRATION_TEXT',
      `Narration text exceeds the application limit of ${MAX_NARRATION_CHARACTERS} characters.`,
      false,
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
    request.voiceId,
  )}/with-timestamps?output_format=${ELEVEN_LABS_OUTPUT_FORMAT}`;

  const body = {
    text: request.text,
    model_id: ELEVEN_LABS_MODEL,
    apply_text_normalization: 'auto',
    voice_settings: {
      stability: request.voiceSettings?.stability ?? DEFAULT_VOICE_SETTINGS.stability,
      similarity_boost: request.voiceSettings?.similarityBoost ?? DEFAULT_VOICE_SETTINGS.similarity_boost,
      style: request.voiceSettings?.style ?? DEFAULT_VOICE_SETTINGS.style,
      use_speaker_boost: request.voiceSettings?.useSpeakerBoost ?? DEFAULT_VOICE_SETTINGS.use_speaker_boost,
      speed: request.voiceSettings?.speed ?? DEFAULT_VOICE_SETTINGS.speed,
    },
  };

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'xi-api-key': options.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // Network failure, timeout, or connection loss after an uncertain dispatch:
    // we cannot tell whether the provider accepted/billed the request.
    throw new ProviderError(
      'PROVIDER_UNKNOWN_OUTCOME',
      `Provider request failed with an ambiguous outcome: ${error instanceof Error ? error.message : String(error)}`,
      false,
      true,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProviderError('PROVIDER_AUTH_FAILED', 'ElevenLabs rejected the configured API key or voice access.', false);
  }
  if (response.status === 429) {
    throw new ProviderError('PROVIDER_RATE_LIMITED', 'ElevenLabs rate-limited this request.', true);
  }
  if (response.status >= 500) {
    throw new ProviderError(
      'PROVIDER_UNKNOWN_OUTCOME',
      `ElevenLabs returned server error ${response.status}; billing outcome is ambiguous.`,
      false,
      true,
    );
  }
  if (!response.ok) {
    const detail = await safeReadText(response);
    throw new ProviderError('PROVIDER_REQUEST_FAILED', `ElevenLabs rejected the request (${response.status}): ${detail}`, false);
  }

  const payload = (await response.json()) as {
    audio_base64: string;
    alignment: NarrationCharacterAlignment | null;
    normalized_alignment: NarrationCharacterAlignment | null;
  };

  const audioBuffer = Buffer.from(payload.audio_base64, 'base64');
  const audio = decodeWav(audioBuffer);

  return {
    audio,
    alignment: payload.alignment ?? null,
    normalizedAlignment: payload.normalized_alignment ?? null,
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}
