import { Rating } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import {
  type MemoryState,
  UNLEARNED,
  applyLessonOutcome,
  applyReviewOutcome,
  isDue,
  reviveCard,
  toGrade,
} from '../../src/domain/memory';

const DAY = 24 * 3600 * 1000;
const now = new Date('2026-10-20T12:00:00Z');
const forms = { explainForm: 'explain_direct', questionForm: 'mcq' };

/** 走一遍"讲解后答对"，得到刚进入回忆阶段的状态 */
function learned(selfRating: 'hard' | 'good' | 'easy' = 'good'): MemoryState {
  return applyLessonOutcome(UNLEARNED, forms, { correct: true, selfRating }, now);
}

describe('记忆评分', () => {
  it('判错直接记为"忘了"，答对按自评映射', () => {
    expect(toGrade({ correct: false })).toBe(Rating.Again);
    expect(toGrade({ correct: true, selfRating: 'hard' })).toBe(Rating.Hard);
    expect(toGrade({ correct: true, selfRating: 'good' })).toBe(Rating.Good);
    expect(toGrade({ correct: true, selfRating: 'easy' })).toBe(Rating.Easy);
  });
});

describe('理解阶段：讲解后的当场小题', () => {
  it('答对后进入回忆阶段，至少隔一天才到期', () => {
    const state = learned();
    expect(state.stage).toBe('recall');
    expect(state.card).not.toBeNull();
    expect(state.card!.due.getTime() - now.getTime()).toBeGreaterThanOrEqual(DAY);
    expect(isDue(state, now)).toBe(false);
  });

  it('答错后留在理解阶段，不开始调度，并记下这次的形式', () => {
    const state = applyLessonOutcome(UNLEARNED, forms, { correct: false }, now);
    expect(state.stage).toBe('understand');
    expect(state.card).toBeNull();
    expect(state.lastExplainForm).toBe('explain_direct');
    expect(state.lastQuestionForm).toBe('mcq');
  });

  it('理解阶段重讲后答对，同样进入回忆阶段', () => {
    const retry = applyLessonOutcome(UNLEARNED, forms, { correct: false }, now);
    const state = applyLessonOutcome(
      retry,
      { explainForm: 'explain_analogy', questionForm: 'short_answer' },
      { correct: true, selfRating: 'good' },
      now,
    );
    expect(state.stage).toBe('recall');
    expect(state.lastExplainForm).toBe('explain_analogy');
  });

  it('自评越轻松，下次到期越晚', () => {
    const due = (r: 'hard' | 'good' | 'easy') => learned(r).card!.due.getTime();
    expect(due('hard')).toBeLessThan(due('good'));
    expect(due('good')).toBeLessThan(due('easy'));
  });

  it('已学过的知识点不能再按讲解结果更新', () => {
    expect(() => applyLessonOutcome(learned(), forms, { correct: true, selfRating: 'good' }, now)).toThrow();
  });
});

describe('回忆阶段：复习', () => {
  it('到期后答对，间隔拉长', () => {
    const state = learned();
    const firstInterval = state.card!.due.getTime() - now.getTime();
    const reviewAt = state.card!.due;
    const next = applyReviewOutcome(state, 'short_answer', { correct: true, selfRating: 'good' }, reviewAt);
    expect(next.stage).toBe('recall');
    expect(next.card!.due.getTime() - reviewAt.getTime()).toBeGreaterThan(firstInterval);
    expect(next.lastQuestionForm).toBe('short_answer');
  });

  it('到期后答错，遗忘次数加一，下次到期比答对时早', () => {
    const state = learned();
    const reviewAt = state.card!.due;
    const wrong = applyReviewOutcome(state, 'short_answer', { correct: false }, reviewAt);
    const right = applyReviewOutcome(state, 'short_answer', { correct: true, selfRating: 'good' }, reviewAt);
    expect(wrong.stage).toBe('recall');
    expect(wrong.card!.lapses).toBe(state.card!.lapses + 1);
    expect(wrong.card!.due.getTime()).toBeLessThan(right.card!.due.getTime());
  });

  it('未学过的知识点不能按复习结果更新', () => {
    expect(() => applyReviewOutcome(UNLEARNED, 'mcq', { correct: false }, now)).toThrow();
  });
});

describe('卡片序列化', () => {
  it('经 JSON 往返后日期仍可用于调度', () => {
    const card = learned().card!;
    const revived = reviveCard(JSON.parse(JSON.stringify(card)))!;
    expect(revived.due).toBeInstanceOf(Date);
    expect(revived.due.getTime()).toBe(card.due.getTime());
    expect(revived.last_review?.getTime()).toBe(card.last_review?.getTime());
  });
});
