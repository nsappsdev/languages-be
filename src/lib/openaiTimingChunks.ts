import { LessonWordTiming, SuggestedTimingChunk } from './lessonTimingAlignment';

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

interface ParsedChunkResponse {
  chunks?: Array<{
    text?: unknown;
    wordMarkIds?: unknown;
  }>;
}

const TIMING_CHUNK_MODEL = process.env.OPENAI_TIMING_CHUNK_MODEL || 'gpt-4o-mini';

export async function suggestLogicalTimingChunks({
  lessonText,
  wordTimings,
}: {
  lessonText: string;
  wordTimings: LessonWordTiming[];
}): Promise<SuggestedTimingChunk[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  if (!wordTimings.length) {
    return [];
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TIMING_CHUNK_MODEL,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: [
                'Group English lesson words into short logical learning chunks.',
                'Prefer natural semantic units such as phrasal verbs, prepositional phrases, names, and short noun phrases.',
                'Combine function words with their content word: examples include "in the fall", "of love", "to him", "the complaint".',
                'Use one-word chunks only for standalone content words that do not belong naturally with neighbors.',
                'Do not translate, rewrite, skip, overlap, or reorder words.',
                'Every chunk must contain contiguous wordMarkIds from the provided list.',
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
                lessonText,
                words: wordTimings.map((mark) => ({
                  id: mark.id,
                  text: mark.text,
                  order: mark.order,
                })),
              }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'lesson_timing_chunks',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              chunks: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    text: { type: 'string' },
                    wordMarkIds: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                  },
                  required: ['text', 'wordMarkIds'],
                },
              },
            },
            required: ['chunks'],
          },
        },
      },
    }),
  });

  const payload = (await response.json()) as OpenAIResponsesPayload;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `OpenAI timing chunking failed with ${response.status}`);
  }

  const parsed = parseChunkResponseText(extractResponseText(payload));
  return (parsed.chunks ?? [])
    .map((chunk) => {
      if (typeof chunk.text !== 'string' || !Array.isArray(chunk.wordMarkIds)) {
        return null;
      }
      const wordMarkIds = chunk.wordMarkIds.filter((id): id is string => typeof id === 'string');
      if (!chunk.text.trim() || !wordMarkIds.length) {
        return null;
      }
      return {
        text: chunk.text.trim(),
        wordMarkIds,
      };
    })
    .filter((chunk): chunk is SuggestedTimingChunk => Boolean(chunk));
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

function parseChunkResponseText(value: string): ParsedChunkResponse {
  if (!value) {
    throw new Error('OpenAI timing chunk response was empty');
  }

  const parsed = JSON.parse(value) as ParsedChunkResponse;
  if (!Array.isArray(parsed.chunks)) {
    throw new Error('OpenAI timing chunk response did not include chunks');
  }
  return parsed;
}
