import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHeuristicLogicalChunkTimings,
  buildLogicalChunkTimings,
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
  assert.deepEqual(
    timings.chunkTimings.map((mark) => [mark.id, mark.normalizedText, mark.wordMarkIds]),
    [
      ['chunk-1', 'hello world', ['word-1', 'word-2']],
      ['chunk-2', 'hello again', ['word-3', 'word-4']],
    ],
  );
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

test('builds logical chunk timings from contiguous suggested word marks', () => {
  const wordTimings = [
    { id: 'word-1', text: 'in', normalizedText: 'in', startMs: 100, endMs: 180, order: 0 },
    { id: 'word-2', text: 'the', normalizedText: 'the', startMs: 190, endMs: 260, order: 1 },
    { id: 'word-3', text: 'fall', normalizedText: 'fall', startMs: 270, endMs: 500, order: 2 },
  ];

  assert.deepEqual(
    buildLogicalChunkTimings({
      suggestedChunks: [{ text: 'in the fall', wordMarkIds: ['word-1', 'word-2', 'word-3'] }],
      wordTimings,
    }),
    [
      {
        id: 'chunk-1',
        text: 'in the fall',
        normalizedText: 'in the fall',
        startMs: 100,
        endMs: 500,
        wordMarkIds: ['word-1', 'word-2', 'word-3'],
        order: 0,
      },
    ],
  );
});

test('builds local logical chunks for short prepositional phrases', () => {
  const wordTimings = [
    { id: 'word-1', text: 'we', normalizedText: 'we', startMs: 0, endMs: 100, order: 0 },
    { id: 'word-2', text: 'met', normalizedText: 'met', startMs: 110, endMs: 220, order: 1 },
    { id: 'word-3', text: 'in', normalizedText: 'in', startMs: 230, endMs: 300, order: 2 },
    { id: 'word-4', text: 'the', normalizedText: 'the', startMs: 310, endMs: 370, order: 3 },
    { id: 'word-5', text: 'fall', normalizedText: 'fall', startMs: 380, endMs: 550, order: 4 },
  ];

  assert.deepEqual(
    buildHeuristicLogicalChunkTimings(wordTimings).map((chunk) => [
      chunk.text,
      chunk.wordMarkIds,
      chunk.startMs,
      chunk.endMs,
    ]),
    [
      ['we', ['word-1'], 0, 100],
      ['met', ['word-2'], 110, 220],
      ['in the fall', ['word-3', 'word-4', 'word-5'], 230, 550],
    ],
  );
});

test('ignores malformed logical chunks with non-contiguous or repeated word marks', () => {
  const wordTimings = [
    { id: 'word-1', text: 'one', normalizedText: 'one', startMs: 0, endMs: 100, order: 0 },
    { id: 'word-2', text: 'two', normalizedText: 'two', startMs: 110, endMs: 200, order: 1 },
    { id: 'word-3', text: 'three', normalizedText: 'three', startMs: 210, endMs: 300, order: 2 },
  ];

  assert.deepEqual(
    buildLogicalChunkTimings({
      suggestedChunks: [
        { text: 'one three', wordMarkIds: ['word-1', 'word-3'] },
        { text: 'one two', wordMarkIds: ['word-1', 'word-2'] },
        { text: 'two three', wordMarkIds: ['word-2', 'word-3'] },
      ],
      wordTimings,
    }).map((chunk) => chunk.text),
    ['one two'],
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
