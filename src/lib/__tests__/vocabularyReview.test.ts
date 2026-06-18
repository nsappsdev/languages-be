import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { applyVocabularyReviewDecision } from '../vocabularyReview';

describe('vocabulary review decisions', () => {
  it('requires two separate know decisions to learn a word', () => {
    const first = applyVocabularyReviewDecision(
      { correctStreak: 0, leftSwipes: 0, rightSwipes: 0, status: 'LEARNING' },
      'KNOW',
    );
    const second = applyVocabularyReviewDecision(first, 'KNOW');

    assert.deepEqual(first, {
      correctStreak: 1,
      leftSwipes: 0,
      rightSwipes: 1,
      status: 'LEARNING',
    });
    assert.deepEqual(second, {
      correctStreak: 2,
      leftSwipes: 0,
      rightSwipes: 2,
      status: 'LEARNED',
    });
  });

  it('resets the streak after again without losing history counters', () => {
    assert.deepEqual(
      applyVocabularyReviewDecision(
        { correctStreak: 1, leftSwipes: 2, rightSwipes: 4, status: 'LEARNING' },
        'AGAIN',
      ),
      {
        correctStreak: 0,
        leftSwipes: 3,
        rightSwipes: 4,
        status: 'LEARNING',
      },
    );
  });
});
