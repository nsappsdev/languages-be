import type { LearnerLessonVocabularyStatus, VocabularyReviewDecision } from '@prisma/client';

export type VocabularyReviewSnapshot = {
  correctStreak: number;
  leftSwipes: number;
  rightSwipes: number;
  status: LearnerLessonVocabularyStatus;
};

export function applyVocabularyReviewDecision(
  current: VocabularyReviewSnapshot,
  decision: VocabularyReviewDecision,
): VocabularyReviewSnapshot {
  if (decision === 'AGAIN') {
    return {
      correctStreak: 0,
      leftSwipes: current.leftSwipes + 1,
      rightSwipes: current.rightSwipes,
      status: 'LEARNING',
    };
  }

  const correctStreak = Math.min(2, current.correctStreak + 1);
  return {
    correctStreak,
    leftSwipes: current.leftSwipes,
    rightSwipes: current.rightSwipes + 1,
    status: correctStreak >= 2 ? 'LEARNED' : 'LEARNING',
  };
}
