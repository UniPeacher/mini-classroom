import type { PoolItem } from './assemble';
import { type GraphPoint, cognitiveEdge } from './edge';
import { EXPLAIN_FORMS, type ExplainForm, QUESTION_FORMS, type QuestionForm, nextForm } from './forms';
import { type MemoryState, UNLEARNED, hasLearned } from './memory';

/** 候选池需要补的一项内容 */
export type PoolNeed =
  | { kind: 'review'; knowledgePointId: string; questionForm: QuestionForm }
  | { kind: 'lesson'; knowledgePointId: string; explainForm: ExplainForm; questionForm: QuestionForm };

export interface PlanPoolInput {
  points: GraphPoint[];
  states: Map<string, MemoryState>;
  pool: PoolItem[];
  now: Date;
  /** 提前多久为即将到期的复习备好内容 */
  horizonMs: number;
  /** 认知边缘上提前备好多少个新知识点 */
  newCount: number;
}

/**
 * 规划候选池要补哪些内容，目标是常备约两节的量：
 * - 即将到期（horizon 内）的复习：每个知识点备一项与上次形式不同的复习题；
 * - 理解阶段的知识点：备一项与上次讲解形式不同的重讲；
 * - 认知边缘上靠前的新知识点：各备一项讲解，当场小题在两种形式间交替。
 * 候选池里已有可用内容的，不重复生成。
 */
export function planPool(input: PlanPoolInput): PoolNeed[] {
  const { points, states, pool, now, horizonMs, newCount } = input;
  const stateOf = (id: string) => states.get(id) ?? UNLEARNED;
  const has = (id: string, kind: PoolItem['kind'], avoidForm: string | null) =>
    pool.some((i) => i.knowledgePointId === id && i.kind === kind && i.form !== avoidForm);
  const byPosition = [...points].sort((a, b) => a.position - b.position);
  const needs: PoolNeed[] = [];

  for (const p of byPosition) {
    const state = stateOf(p.id);
    const dueSoon = hasLearned(state.stage) && state.card !== null && state.card.due.getTime() <= now.getTime() + horizonMs;
    if (dueSoon && !has(p.id, 'review', state.lastQuestionForm)) {
      needs.push({ kind: 'review', knowledgePointId: p.id, questionForm: nextForm(QUESTION_FORMS, state.lastQuestionForm) });
    }
    if (state.stage === 'understand' && !has(p.id, 'lesson', state.lastExplainForm)) {
      needs.push({
        kind: 'lesson',
        knowledgePointId: p.id,
        explainForm: nextForm(EXPLAIN_FORMS, state.lastExplainForm),
        questionForm: nextForm(QUESTION_FORMS, state.lastQuestionForm),
      });
    }
  }

  cognitiveEdge(points, states)
    .slice(0, newCount)
    .forEach((p, index) => {
      if (has(p.id, 'lesson', null)) return;
      needs.push({
        kind: 'lesson',
        knowledgePointId: p.id,
        explainForm: EXPLAIN_FORMS[0],
        questionForm: QUESTION_FORMS[index % QUESTION_FORMS.length]!,
      });
    });

  return needs;
}
