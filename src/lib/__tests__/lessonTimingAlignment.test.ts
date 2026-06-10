import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generateLessonTimingsFromTranscript,
} from '../lessonTimingAlignment';

test('generates word and sentence timings from aligned transcript words', () => {
  const timings = generateLessonTimingsFromTranscript({
    lessonText: 'Hello world. Hello again!',
    transcriptText: 'Hello world. Hello again.',
    transcriptWords: [
      { word: 'Hello', start: 0.1, end: 0.4 },
      { word: 'world', start: 0.45, end: 0.9 },
      { word: 'Hello', start: 1.2, end: 1.5 },
      { word: 'again', start: 1.55, end: 2.0 },
    ],
  });

  assert.deepEqual(
    timings.wordTimings.map((mark) => [mark.id, mark.normalizedText, mark.startMs, mark.endMs]),
    [
      ['word-1', 'hello', 100, 400],
      ['word-2', 'world', 450, 900],
      ['word-3', 'hello', 1200, 1500],
      ['word-4', 'again', 1550, 2000],
    ],
  );
  assert.deepEqual(
    timings.sentenceTimings.map((mark) => [mark.id, mark.startMs, mark.endMs, mark.wordMarkIds]),
    [
      ['sentence-1', 100, 900, ['word-1', 'word-2']],
      ['sentence-2', 1200, 2000, ['word-3', 'word-4']],
    ],
  );
  assert.deepEqual(timings.segments, [
    { id: 'sentence-1', text: 'Hello world.', startMs: 100, endMs: 900 },
    { id: 'sentence-2', text: 'Hello again!', startMs: 1200, endMs: 2000 },
  ]);
  assert.deepEqual(timings.chunkTimings, []);
});

test('preserves alignment order when repeated words appear', () => {
  const timings = generateLessonTimingsFromTranscript({
    lessonText: 'Read. Read the line.',
    transcriptText: 'Read. Read the line.',
    transcriptWords: [
      { word: 'Read', start: 0, end: 0.3 },
      { word: 'Read', start: 0.7, end: 1.0 },
      { word: 'the', start: 1.05, end: 1.15 },
      { word: 'line', start: 1.2, end: 1.55 },
    ],
  });

  assert.deepEqual(
    timings.wordTimings.map((mark) => [mark.text, mark.startMs]),
    [
      ['Read', 0],
      ['Read', 700],
      ['the', 1050],
      ['line', 1200],
    ],
  );
});

test('preserves provider timestamps instead of forcing the first word to zero', () => {
  const timings = generateLessonTimingsFromTranscript({
    lessonText: 'Everyone has insecurities. When you speak.',
    transcriptText: 'Everyone has insecurities. When you speak.',
    transcriptWords: [
      { word: 'Everyone', start: 9.9, end: 10.1 },
      { word: 'has', start: 10.15, end: 10.3 },
      { word: 'insecurities', start: 10.35, end: 10.62 },
      { word: 'When', start: 10.8, end: 11.0 },
      { word: 'you', start: 11.05, end: 11.15 },
      { word: 'speak', start: 11.2, end: 11.5 },
    ],
  });

  assert.deepEqual(
    timings.wordTimings.map((mark) => [mark.normalizedText, mark.startMs, mark.endMs]),
    [
      ['everyone', 9900, 10100],
      ['has', 10150, 10300],
      ['insecurities', 10350, 10620],
      ['when', 10800, 11000],
      ['you', 11050, 11150],
      ['speak', 11200, 11500],
    ],
  );
  assert.deepEqual(
    timings.segments.map((segment) => [segment.startMs, segment.endMs]),
    [
      [9900, 10620],
      [10800, 11500],
    ],
  );
});

test('repairs collapsed provider timestamps using the audio duration', () => {
  const timings = generateLessonTimingsFromTranscript({
    lessonText: 'Everyone has insecurities. When you speak.',
    transcriptText: 'Everyone has insecurities. When you speak.',
    transcriptWords: [
      { word: 'Everyone', start: 0, end: 0.24 },
      { word: 'has', start: 0, end: 0.24 },
      { word: 'insecurities', start: 0, end: 0.24 },
      { word: 'When', start: 0, end: 0.24 },
      { word: 'you', start: 0, end: 0.24 },
      { word: 'speak', start: 0, end: 0.24 },
    ],
    audioDurationSeconds: 12,
  });

  assert.equal(timings.wordTimings[0].startMs, 0);
  assert.equal(timings.wordTimings.at(-1)?.endMs, 12000);
  assert.ok(
    timings.wordTimings.every(
      (mark, index) =>
        index === 0 || mark.startMs >= timings.wordTimings[index - 1].endMs,
    ),
  );
  assert.deepEqual(
    timings.sentenceTimings.map((mark) => mark.wordMarkIds),
    [
      ['word-1', 'word-2', 'word-3'],
      ['word-4', 'word-5', 'word-6'],
    ],
  );
  assert.ok(
    timings.warnings.includes(
      'AI returned collapsed word timestamps, so word ranges were estimated across the audio duration.',
    ),
  );
});

test('estimates unmatched lesson words from neighboring transcript timings', () => {
  const timings = generateLessonTimingsFromTranscript({
    lessonText: 'The quick brown fox.',
    transcriptText: 'The quick fox.',
    transcriptWords: [
      { word: 'The', start: 0, end: 0.15 },
      { word: 'quick', start: 0.2, end: 0.5 },
      { word: 'fox', start: 0.7, end: 1.0 },
    ],
  });

  assert.deepEqual(
    timings.wordTimings.map((mark) => [mark.normalizedText, mark.startMs, mark.endMs]),
    [
      ['the', 0, 150],
      ['quick', 200, 500],
      ['brown', 500, 700],
      ['fox', 700, 1000],
    ],
  );
  assert.ok(
    timings.warnings.includes('Estimated audio timestamp for "brown" from neighboring words.'),
  );
});
