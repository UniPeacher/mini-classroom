import { State, createEmptyCard } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import {
  APPLY_STABILITY_DAYS,
  DECOMPOSE_FAIL_STREAK,
  type MemoryState,
  RETAIN_STABILITY_DAYS,
  UNLEARNED,
  applyLessonOutcome,
  applyReviewOutcome,
  fromPlacement,
  hasLearned,
  needsDecomposition,
} from '../../src/domain/memory';

const DAY = 24 * 3600 * 1000;
const now = new Date('2026-10-20T12:00:00Z');
const forms = { explainForm: 'explain_direct', questionForm: 'mcq' };

/** 某阶段、记忆稳定性为 stability 天、今天到期的知识点 */
function at(stage: MemoryState['stage'], stability: number): MemoryState {
  const lastReview = new Date(now.getTime() - stability * DAY);
  const card = { ...createEmptyCard(lastReview), state: State.Review, stability, difficulty: 5, reps: 3, last_review: lastReview, due: now };
  return { ...UNLEARNED, stage, card };
}

describe('四个掌握阶段的推进', () => {
  it('回忆阶段答对、记忆稳定性达到阈值，进入应用阶段', () => {
    const next = applyReviewOutcome(at('recall', 10), 'mcq', { correct: true, selfRating: 'good' }, now);
    expect(next.card!.stability).toBeGreaterThanOrEqual(APPLY_STABILITY_DAYS);
    expect(next.stage).toBe('apply');
  });

  it('回忆阶段答对、但记忆还不稳定，留在回忆阶段', () => {
    const next = applyReviewOutcome(at('recall', 0.5), 'mcq', { correct: true, selfRating: 'hard' }, now);
    expect(next.card!.stability).toBeLessThan(APPLY_STABILITY_DAYS);
    expect(next.stage).toBe('recall');
  });

  it('应用阶段答对、记忆稳定性达到阈值，进入保持阶段', () => {
    const next = applyReviewOutcome(at('apply', 40), 'fix', { correct: true, selfRating: 'good' }, now);
    expect(next.card!.stability).toBeGreaterThanOrEqual(RETAIN_STABILITY_DAYS);
    expect(next.stage).toBe('retain');
  });

  it('应用、保持阶段答错，退回回忆阶段，间隔缩短', () => {
    for (const stage of ['apply', 'retain'] as const) {
      const state = at(stage, 40);
      const wrong = applyReviewOutcome(state, 'fix', { correct: false, errorType: 'forgetting' }, now);
      const right = applyReviewOutcome(state, 'fix', { correct: true, selfRating: 'good' }, now);
      expect(wrong.stage).toBe('recall');
      expect(wrong.card!.due.getTime()).toBeLessThan(right.card!.due.getTime());
    }
  });

  it('保持阶段答对，留在保持阶段', () => {
    expect(applyReviewOutcome(at('retain', 60), 'short_answer', { correct: true, selfRating: 'good' }, now).stage).toBe('retain');
  });
});

describe('错误类型的后果', () => {
  it('答错且属于误解：标记下次改用对比讲解，并记下误解内容', () => {
    const next = applyLessonOutcome(UNLEARNED, forms, { correct: false, errorType: 'misconception', misconception: '把 any 当成 unknown' }, now);
    expect(next).toMatchObject({ stage: 'understand', pendingContrast: true, lastMisconception: '把 any 当成 unknown' });
  });

  it('答错属于遗忘：不触发对比讲解', () => {
    const next = applyReviewOutcome(at('recall', 3), 'mcq', { correct: false, errorType: 'forgetting' }, now);
    expect(next).toMatchObject({ pendingContrast: false, lastMisconception: null });
  });

  it('对比讲解后答对，清除对比讲解标记', () => {
    const misled = { ...at('recall', 3), pendingContrast: true, lastMisconception: '误解' };
    expect(applyReviewOutcome(misled, 'mcq', { correct: true, selfRating: 'good' }, now)).toMatchObject({ pendingContrast: false, lastMisconception: null });
  });

  it(`理解或回忆阶段连续答错 ${DECOMPOSE_FAIL_STREAK} 次，需要拆解；中途答对一次就重新计数`, () => {
    const wrong = { correct: false, errorType: 'forgetting' } as const;
    let state = applyLessonOutcome(UNLEARNED, forms, wrong, now);
    state = applyLessonOutcome(state, forms, wrong, now);
    expect(needsDecomposition(state)).toBe(false);
    state = applyLessonOutcome(state, forms, wrong, now);
    expect(state.failStreak).toBe(DECOMPOSE_FAIL_STREAK);
    expect(needsDecomposition(state)).toBe(true);

    const recovered = applyLessonOutcome(state, forms, { correct: true, selfRating: 'good' }, now);
    expect(recovered.failStreak).toBe(0);
  });

  it('应用阶段答错不计入连续失败：那不是"理解或回忆阶段反复失败"', () => {
    const next = applyReviewOutcome({ ...at('apply', 20), failStreak: 2 }, 'fix', { correct: false, errorType: 'forgetting' }, now);
    expect(next.failStreak).toBe(0);
  });
});

describe('摸底诊断与推断掌握', () => {
  it('直接答对：不再教，进入回忆阶段，约两三周后到期再验证', () => {
    const state = fromPlacement('correct', now);
    expect(state.stage).toBe('recall');
    const days = (state.card!.due.getTime() - now.getTime()) / DAY;
    expect(days).toBeGreaterThanOrEqual(10);
    expect(days).toBeLessThanOrEqual(25);
  });

  it('推断掌握：视同学过（后续知识点可以进入认知边缘），但没有间隔调度', () => {
    const state = fromPlacement('inferred', now);
    expect(state).toMatchObject({ stage: 'inferred', card: null });
    expect(hasLearned(state.stage)).toBe(true);
  });

  it('选"不知道"或答错：按未学处理', () => {
    expect(fromPlacement('unknown', now)).toEqual(UNLEARNED);
  });

  it('推断掌握的抽查答对，视为已掌握，进入回忆阶段', () => {
    const next = applyReviewOutcome(fromPlacement('inferred', now), 'mcq', { correct: true, selfRating: 'good' }, now);
    expect(next.stage).toBe('recall');
    expect(next.card).not.toBeNull();
  });

  it('推断掌握的抽查答错，从理解阶段开始教', () => {
    const next = applyReviewOutcome(fromPlacement('inferred', now), 'mcq', { correct: false, errorType: 'forgetting' }, now);
    expect(next).toMatchObject({ stage: 'understand', card: null });
  });
});
