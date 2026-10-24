import { State, createEmptyCard } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { type PoolItem, assemble } from '../../src/domain/assemble';
import { type GraphPoint, cognitiveEdge } from '../../src/domain/edge';
import { type MemoryState, UNLEARNED } from '../../src/domain/memory';
import { planPool } from '../../src/domain/plan-pool';

const DAY = 24 * 3600 * 1000;
const now = new Date('2026-10-20T12:00:00Z');
const assembleBase = { now, budgetSeconds: 600, maxNewPerSession: 2 };
const planBase = { now, horizonMs: 2 * DAY, newCount: 4 };

const point = (id: string, position: number, excluded = false, prerequisiteIds: string[] = []): GraphPoint => ({
  id,
  position,
  prerequisiteIds,
  excluded,
});

/** 构造已经到期的记忆卡，以覆盖复习和误解对比讲解。 */
function dueState(stage: MemoryState['stage'] = 'recall'): MemoryState {
  const lastReview = new Date(now.getTime() - 5 * DAY);
  const card = createEmptyCard(lastReview);
  return {
    ...UNLEARNED,
    stage,
    card: {
      ...card,
      state: State.Review,
      stability: 2,
      difficulty: 5,
      reps: 2,
      last_review: lastReview,
      due: new Date(now.getTime() - DAY),
    },
    lastExplainForm: 'explain_direct',
    lastQuestionForm: 'mcq',
  };
}

const lesson = (id: string, form = 'explain_direct'): PoolItem => ({
  id: `lesson-${id}-${form}`,
  knowledgePointId: id,
  kind: 'lesson',
  form,
  questionForm: 'mcq',
  estSeconds: 120,
});

const review = (id: string): PoolItem => ({
  id: `review-${id}`,
  knowledgePointId: id,
  kind: 'review',
  form: 'short_answer',
  questionForm: 'short_answer',
  estSeconds: 60,
});

const learningPaths: { name: string; state: MemoryState; item: (id: string) => PoolItem }[] = [
  { name: '未学的新知识', state: { ...UNLEARNED }, item: (id) => lesson(id) },
  { name: '理解阶段的重讲', state: { ...UNLEARNED, stage: 'understand', lastExplainForm: 'explain_direct' }, item: (id) => lesson(id, 'explain_analogy') },
  { name: '回忆阶段的到期复习', state: dueState(), item: review },
  { name: '应用阶段的到期复习', state: dueState('apply'), item: review },
  { name: '保持阶段的到期复习', state: dueState('retain'), item: review },
  { name: '误解后的对比讲解', state: { ...dueState(), pendingContrast: true }, item: (id) => lesson(id, 'explain_contrast') },
  { name: '推断掌握的抽查', state: { ...UNLEARNED, stage: 'inferred' }, item: review },
];

describe('不学：排课与候选生成', () => {
  it.each(learningPaths)('$name：不学时不排课，恢复后仍按原记忆状态安排', ({ state, item }) => {
    const points = [point('ignored', 1, true), point('active', 2)];
    const states = new Map([['ignored', state], ['active', state]]);
    const before = structuredClone(states);
    const pool = [item('ignored'), item('active')];

    expect(assemble({ ...assembleBase, points, states, pool }).items.map((i) => i.knowledgePointId)).toEqual(['active']);
    points[0]!.excluded = false;
    expect(assemble({ ...assembleBase, points, states, pool }).items.map((i) => i.knowledgePointId)).toEqual(['ignored', 'active']);
    expect(states).toEqual(before);
  });

  it.each(learningPaths)('$name：不为不学项生成候选，恢复后重新参与候选规划', ({ state }) => {
    const points = [point('ignored', 1, true), point('active', 2)];
    const states = new Map([['ignored', state], ['active', state]]);
    const input = { ...planBase, points, states, pool: [] };

    expect(new Set(planPool(input).map((need) => need.knowledgePointId))).toEqual(new Set(['active']));
    points[0]!.excluded = false;
    expect(new Set(planPool(input).map((need) => need.knowledgePointId))).toEqual(new Set(['ignored', 'active']));
  });

  it('不学的到期项不算复习积压，不挤掉正常新学', () => {
    const excluded = Array.from({ length: 31 }, (_, i) => point(`ignored-${i}`, i, true));
    const points = [...excluded, point('active-review', 40), point('new', 41)];
    const states = new Map([...excluded, points[31]!].map((p) => [p.id, dueState()]));
    const pool = [...excluded.map((p) => review(p.id)), review('active-review'), lesson('new')];

    const result = assemble({ ...assembleBase, points, states, pool });
    expect(result.newPaused).toBe(false);
    expect(result.items.map((i) => i.knowledgePointId)).toEqual(['active-review', 'new']);
  });
});

describe('不学：前置关系只放行，不伪造掌握', () => {
  it('不学的前置允许继续后续知识，但仍保留未学状态；恢复后重新检查前置', () => {
    const points = [point('basic', 1, true), point('next', 2, false, ['basic'])];
    const states = new Map([['basic', { ...UNLEARNED }]]);

    expect(cognitiveEdge(points, states).map((p) => p.id)).toEqual(['next']);
    expect(states.get('basic')).toEqual(UNLEARNED);
    points[0]!.excluded = false;
    expect(cognitiveEdge(points, states).map((p) => p.id)).toEqual(['basic']);
  });

  it('只豁免明确不学的前置，其他未学前置仍需学习', () => {
    const points = [point('ignored', 1, true), point('required', 2), point('next', 3, false, ['ignored', 'required'])];
    expect(cognitiveEdge(points, new Map()).map((p) => p.id)).toEqual(['required']);
    const states = new Map([['required', { ...UNLEARNED, stage: 'recall' as const }]]);
    expect(cognitiveEdge(points, states).map((p) => p.id)).toEqual(['next']);
  });

  it('前置设为不学后，已有理解阶段的后续知识也能继续重讲和生成候选', () => {
    const points = [point('basic', 1, true), point('next', 2, false, ['basic'])];
    const states = new Map<string, MemoryState>([['next', { ...UNLEARNED, stage: 'understand', lastExplainForm: 'explain_direct' }]]);

    expect(assemble({ ...assembleBase, points, states, pool: [lesson('basic'), lesson('next', 'explain_analogy')] }).items.map((i) => i.knowledgePointId)).toEqual(['next']);
    expect(planPool({ ...planBase, points, states, pool: [] })).toEqual([
      { kind: 'lesson', knowledgePointId: 'next', explainForm: 'explain_analogy', questionForm: 'mcq' },
    ]);
  });

  it('不学的前置不会绕过主题暂停或诊断未完成的限制', () => {
    const points = [point('basic', 1, true), { ...point('next', 2, false, ['basic']), learnable: false }];
    expect(cognitiveEdge(points, new Map())).toEqual([]);
  });
});
