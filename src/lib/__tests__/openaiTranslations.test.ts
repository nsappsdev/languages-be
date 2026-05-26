import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { translateVocabularyToArmenian } from '../openaiTranslations';

const originalFetch = global.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;

describe('OpenAI vocabulary translations', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  });

  it('maps short model keys back to vocabulary ids', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    let requestBodyText = '';

    global.fetch = (async (_url, init) => {
      requestBodyText = String(init?.body);
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            translations: [
              { key: 'term_1', translation: 'սերիալներ' },
              { key: 'term_2', translation: 'աշուն' },
            ],
          }),
        }),
      } as Response;
    }) as typeof fetch;

    const translations = await translateVocabularyToArmenian({
      lessonTitle: 'Lesson',
      lessonText: 'Soap operas in the fall.',
      entries: [
        { id: 'uuid-soap-operas', englishText: 'soap operas', kind: 'PHRASE' },
        { id: 'uuid-in-the-fall', englishText: 'in the fall', kind: 'PHRASE' },
      ],
    });

    assert.deepEqual(translations, [
      { id: 'uuid-soap-operas', translation: 'սերիալներ' },
      { id: 'uuid-in-the-fall', translation: 'աշուն' },
    ]);
    const requestBody = JSON.parse(requestBodyText) as {
      input: Array<{ content: Array<{ text: string }> }>;
    };
    const userPayload = JSON.parse(requestBody.input[1].content[0].text);
    assert.deepEqual(
      userPayload.entries.map((entry: { key: string; englishText: string }) => [
        entry.key,
        entry.englishText,
      ]),
      [
        ['term_1', 'soap operas'],
        ['term_2', 'in the fall'],
      ],
    );
  });
});
