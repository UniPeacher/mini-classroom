import { State, createEmptyCard } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import type { PoolItem } from '../../src/domain/assemble';
import type { GraphPoint } from '../../src/domain/edge';
import { type MemoryState, UNLEARNED } from '../../src/domain/memory';
import { planPool } from '../../src/domain/plan-pool';

const HOUR = 3600 * 1000;
const now = new Date('2026-10-20T12:00:00Z');
const base = { now, horizonMs: 48 * HOUR, newCount: 4 };

const point = (id: string, position: number, prerequisiteIds: string[] = []): GraphPoint => ({ id, position, prerequisiteIds });

function recallDueIn(hours: number, lastQuestionForm = 'mcq'): MemoryState {
  const card = { ...createEmptyCard(now), state: State.Review, reps: 1, stability: 2, due: new Date(now.getTime() + hours * HOUR) };
  return { stage: 'recall', card, lastExplainForm: 'explain_direct', lastQuestionForm };
}

const item = (knowledgePointId: string, kind: PoolItem['kind'], form: string): PoolItem => ({
  id: `${knowledgePointId}-${kind}-${form}`,
  knowledgePointId,
  kind,
  form,
  estSeconds: 60,
});

describe('候选池补充规划', () => {
  it('新主题：为认知边缘上靠前的新知识点备讲解，小题形式交替', () => {
    const points = [point('a', 1), point('b', 2), point('c', 3), point('d', 4), point('e', 5), point('f', 6, ['a'])];
    const needs = planPool({ ...base, points, states: new Map(), pool: [] });
    expect(needs).toEqual([
      { kind: 'lesson', knowledgePointId: 'a', explainForm: 'explain_direct', questionForm: 'mcq' },
      { kind: 'lesson', knowledgePointId: 'b', explainForm: 'explain_direct', questionForm: 'short_answer' },
      { kind: 'lesson', knowledgePointId: 'c', explainForm: 'explain_direct', questionForm: 'mcq' },
      { kind: 'lesson', knowledgePointId: 'd', explainForm: 'explain_direct', questionForm: 'short_answer' },
    ]);
  });

  it('候选池里已有讲解的新知识点不重复生成', () => {
    const needs = planPool({ ...base, points: [point('a', 1)], states: new Map(), pool: [item('a', 'lesson', 'explain_direct')] });
    expect(needs).toEqual([]);
  });

  it('即将到期的复习备一项与上次形式不同的题；太远的不备', () => {
    const points = [point('soon', 1), point('far', 2)];
    const states = new Map([
      ['soon', recallDueIn(24, 'mcq')],
      ['far', recallDueIn(72, 'mcq')],
    ]);
    expect(planPool({ ...base, points, states, pool: [] })).toEqual([
      { kind: 'review', knowledgePointId: 'soon', questionForm: 'short_answer' },
    ]);
  });

  it('候选池里只有与上次相同形式的复习题时，仍要补一项不同形式的', () => {
    const states = new Map([['a', recallDueIn(1, 'mcq')]]);
    const needs = planPool({ ...base, points: [point('a', 1)], states, pool: [item('a', 'review', 'mcq')] });
    expect(needs).toEqual([{ kind: 'review', knowledgePointId: 'a', questionForm: 'short_answer' }]);
  });

  it('理解阶段的知识点备一项换了讲解形式和小题形式的重讲', () => {
    const states = new Map<string, MemoryState>([
      ['a', { ...UNLEARNED, stage: 'understand', lastExplainForm: 'explain_direct', lastQuestionForm: 'short_answer' }],
    ]);
    expect(planPool({ ...base, points: [point('a', 1)], states, pool: [item('a', 'lesson', 'explain_direct')] })).toEqual([
      { kind: 'lesson', knowledgePointId: 'a', explainForm: 'explain_analogy', questionForm: 'mcq' },
    ]);
  });
});
