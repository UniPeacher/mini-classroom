import { type Card, type Grade, Rating, createEmptyCard, fsrs } from 'ts-fsrs';

export type Stage = 'unlearned' | 'understand' | 'recall' | 'apply' | 'retain';
export type SelfRating = 'hard' | 'good' | 'easy';

/** 一次作答的结果：答错时不自评；答对时由用户自评难度。 */
export type Outcome = { correct: false } | { correct: true; selfRating: SelfRating };

/** 记忆状态：按"用户 × 知识点"只记一份。 */
export interface MemoryState {
  stage: Stage;
  card: Card | null;
  lastExplainForm: string | null;
  lastQuestionForm: string | null;
}

export const UNLEARNED: MemoryState = {
  stage: 'unlearned',
  card: null,
  lastExplainForm: null,
  lastQuestionForm: null,
};

// 微课堂之间通常相隔数小时，不使用分钟级的短期学习步；关闭随机扰动，保证调度可复现。
export const scheduler = fsrs({ enable_short_term: false, enable_fuzz: false });

/** 记忆评分：判错直接记"忘了"，答对按自评映射。 */
export function toGrade(outcome: Outcome): Grade {
  if (!outcome.correct) return Rating.Again;
  const map: Record<SelfRating, Grade> = { hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };
  return map[outcome.selfRating];
}

/** 已进入回忆及之后的阶段，视为"学过"。 */
export function hasLearned(stage: Stage): boolean {
  return stage === 'recall' || stage === 'apply' || stage === 'retain';
}

/**
 * 讲解后的当场小题作答完毕。
 * 答对：进入回忆阶段，开始间隔调度。答错：留在理解阶段，下次换一种讲解形式重讲。
 */
export function applyLessonOutcome(
  state: MemoryState,
  forms: { explainForm: string; questionForm: string },
  outcome: Outcome,
  now: Date,
): MemoryState {
  if (hasLearned(state.stage)) throw new Error(`知识点已处于 ${state.stage} 阶段，不能再按讲解结果更新`);
  const base = { lastExplainForm: forms.explainForm, lastQuestionForm: forms.questionForm };
  if (!outcome.correct) return { ...base, stage: 'understand', card: null };
  const card = scheduler.next(createEmptyCard(now), now, toGrade(outcome)).card;
  return { ...base, stage: 'recall', card };
}

/** 复习题作答完毕：按记忆评分更新卡片；答错时间隔自动缩短，阶段不变。 */
export function applyReviewOutcome(
  state: MemoryState,
  questionForm: string,
  outcome: Outcome,
  now: Date,
): MemoryState {
  if (!hasLearned(state.stage) || state.card === null) throw new Error('知识点尚未进入回忆阶段，不能按复习结果更新');
  const card = scheduler.next(state.card, now, toGrade(outcome)).card;
  return { ...state, card, lastQuestionForm: questionForm };
}

/**
 * 重新学习：已学过的知识点退回理解阶段，清掉间隔调度。
 * 理解阶段的知识点由下一节微课堂换一种讲解形式重讲，答对后重新开始调度。
 */
export function relearn(state: MemoryState): MemoryState {
  if (!hasLearned(state.stage)) throw new Error(`知识点处于 ${state.stage} 阶段，还没学过，不能重新学习`);
  return { ...state, stage: 'understand', card: null };
}

/** 此刻是否到期复习。 */
export function isDue(state: MemoryState, now: Date): boolean {
  return hasLearned(state.stage) && state.card !== null && state.card.due.getTime() <= now.getTime();
}

/** 此刻还能想起来的概率，越低越容易忘。 */
export function retrievability(card: Card, now: Date): number {
  return scheduler.get_retrievability(card, now, false);
}

/** 从数据库 JSON 还原卡片中的日期字段。 */
export function reviveCard(raw: unknown): Card | null {
  if (raw === null || raw === undefined) return null;
  const card = raw as Card & { due: string | Date; last_review?: string | Date };
  return {
    ...card,
    due: new Date(card.due),
    last_review: card.last_review === undefined ? undefined : new Date(card.last_review),
  };
}
