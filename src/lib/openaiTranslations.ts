export interface VocabularyTranslationRequest {
  id: string;
  englishText: string;
  kind: string;
}

export interface VocabularyTranslationResult {
  id: string;
  translation: string;
}

interface OpenAITranslationEntry {
  key: string;
  englishText: string;
  kind: string;
}

interface OpenAIResponsesPayload {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
      type?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
}

interface ParsedTranslationResponse {
  translations?: Array<{
    key?: unknown;
    translation?: unknown;
  }>;
}

const TRANSLATION_MODEL = process.env.OPENAI_TRANSLATION_MODEL || 'gpt-4o-mini';

export async function translateVocabularyToArmenian({
  lessonTitle,
  lessonText,
  entries,
}: {
  lessonTitle: string;
  lessonText: string;
  entries: VocabularyTranslationRequest[];
}): Promise<VocabularyTranslationResult[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  if (!entries.length) {
    return [];
  }

  const entriesForModel: OpenAITranslationEntry[] = entries.map((entry, index) => ({
    key: `term_${index + 1}`,
    englishText: entry.englishText,
    kind: entry.kind,
  }));
  const idByKey = new Map(entriesForModel.map((entry, index) => [entry.key, entries[index].id]));

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TRANSLATION_MODEL,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: [
                'Translate English lesson vocabulary into natural Eastern Armenian.',
                'Return only the best Armenian translation for each provided id.',
                'Preserve semantic units: phrases should be translated as a phrase, not word-by-word.',
                'Do not add explanations, alternatives, punctuation, or Latin transliterations.',
              ].join(' '),
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                lessonTitle,
                lessonText,
                entries: entriesForModel,
              }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'lesson_vocabulary_translations',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              translations: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    key: { type: 'string' },
                    translation: { type: 'string' },
                  },
                  required: ['key', 'translation'],
                },
              },
            },
            required: ['translations'],
          },
        },
      },
    }),
  });

  const payload = (await response.json()) as OpenAIResponsesPayload;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `OpenAI translation failed with ${response.status}`);
  }

  const parsed = parseTranslationResponseText(extractResponseText(payload));
  const translations: VocabularyTranslationResult[] = [];
  for (const entry of parsed.translations ?? []) {
    if (typeof entry.key !== 'string' || typeof entry.translation !== 'string') {
      continue;
    }
    const id = idByKey.get(entry.key);
    const translation = entry.translation.trim();
    if (!id || !translation) {
      continue;
    }
    translations.push({ id, translation });
  }

  if (!translations.length) {
    throw new Error('OpenAI did not return usable vocabulary translations');
  }

  return translations;
}

function extractResponseText(payload: OpenAIResponsesPayload) {
  if (payload.output_text) {
    return payload.output_text;
  }

  return (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((content) => content.text ?? '')
    .join('')
    .trim();
}

function parseTranslationResponseText(value: string): ParsedTranslationResponse {
  if (!value) {
    throw new Error('OpenAI translation response was empty');
  }

  const parsed = JSON.parse(value) as ParsedTranslationResponse;
  if (!Array.isArray(parsed.translations)) {
    throw new Error('OpenAI translation response did not include translations');
  }
  return parsed;
}
