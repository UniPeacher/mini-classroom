import { State, createEmptyCard } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { BACKLOG_SESSIONS, type PoolItem, assemble } from '../../src/domain/assemble';
import type { GraphPoint } from '../../src/domain/edge';
import { type MemoryState, UNLEARNED } from '../../src/domain/memory';

const DAY = 24 * 3600 * 1000;
const now = new Date('2026-10-20T12:00:00Z');

/** 回忆阶段的知识点：逾期天数越多越容易忘 */
function recall(overdueDays: number, lastQuestionForm = 'mcq'): MemoryState {
  const lastReview = new Date(now.getTime() - (overdueDays + 2) * DAY);
  const card = {
    ...createEmptyCard(lastReview),
    state: State.Review,
    stability: 2,
    difficulty: 5,
    reps: 1,
    last_review: lastReview,
    due: new Date(now.getTime() - overdueDays * DAY),
  };
  return { stage: 'recall', card, lastExplainForm: 'explain_direct', lastQuestionForm };
}

function notDue(): MemoryState {
  const state = recall(0);
  return { ...state, card: { ...state.card!, due: new Date(now.getTime() + DAY) } };
}

const point = (id: string, position: number, prerequisiteIds: string[] = []): GraphPoint => ({ id, position, prerequisiteIds });
const review = (kp: string, form = 'short_answer', estSeconds = 60): PoolItem => ({
  id: `r-${kp}-${form}`,
  knowledgePointId: kp,
  kind: 'review',
  form,
  estSeconds,
});
const lesson = (kp: string, form = 'explain_direct', estSeconds = 180): PoolItem => ({
  id: `l-${kp}-${form}`,
  knowledgePointId: kp,
  kind: 'lesson',
  form,
  estSeconds,
});

const base = { now, budgetSeconds: 600, maxNewPerSession: 2 };
const ids = (items: PoolItem[]) => items.map((i) => i.id);
const total = (items: PoolItem[]) => items.reduce((s, i) => s + i.estSeconds, 0);
const reviewsFor = (count: number) => Array.from({ length: count }, (_, i) => point(`k${i}`, i));

describe('组装规则', () => {
  it('到期复习按遗忘风险排序，最容易忘的在前；未到期的不排', () => {
    const points = [point('a', 1), point('b', 2), point('c', 3)];
    const states = new Map([
      ['a', recall(1)],
      ['b', recall(5)],
      ['c', notDue()],
    ]);
    const { items } = assemble({ ...base, points, states, pool: [review('a'), review('b'), review('c')] });
    expect(ids(items)).toEqual(['r-b-short_answer', 'r-a-short_answer']);
  });

  it('优先选与上次不同的形式', () => {
    const states = new Map([['a', recall(1, 'mcq')]]);
    const { items } = assemble({ ...base, points: [point('a', 1)], states, pool: [review('a', 'mcq'), review('a', 'short_answer')] });
    expect(ids(items)).toEqual(['r-a-short_answer']);
  });

  it('只有相同形式时仍安排复习，不让到期复习被跳过', () => {
    const states = new Map([['a', recall(1, 'mcq')]]);
    const { items } = assemble({ ...base, points: [point('a', 1)], states, pool: [review('a', 'mcq')] });
    expect(ids(items)).toEqual(['r-a-mcq']);
  });

  it('理解阶段的知识点用不同的讲解形式重讲', () => {
    const states = new Map<string, MemoryState>([['a', { ...UNLEARNED, stage: 'understand', lastExplainForm: 'explain_direct' }]]);
    const pool = [lesson('a', 'explain_direct'), lesson('a', 'explain_analogy')];
    const { items } = assemble({ ...base, points: [point('a', 1)], states, pool });
    expect(ids(items)).toEqual(['l-a-explain_analogy']);
  });

  it('已学过的知识点不再选用讲解内容', () => {
    const { items } = assemble({ ...base, points: [point('a', 1)], states: new Map([['a', notDue()]]), pool: [lesson('a')] });
    expect(items).toEqual([]);
  });

  it('总时长不超过预算', () => {
    const points = reviewsFor(12);
    const states = new Map(points.map((p, i) => [p.id, recall(i + 1)]));
    const pool = points.map((p) => review(p.id, 'short_answer', 90));
    const { items } = assemble({ ...base, points, states, pool, maxNewPerSession: 0 });
    expect(total(items)).toBeLessThanOrEqual(600);
    expect(items).toHaveLength(6);
  });

  it('新学保底：复习足以占满预算时，仍安排 1 个新知识点', () => {
    const reviewPoints = reviewsFor(10);
    const points = [...reviewPoints, point('new1', 100), point('new2', 101)];
    const states = new Map(reviewPoints.map((p, i) => [p.id, recall(i + 1)]));
    const pool = [...reviewPoints.map((p) => review(p.id)), lesson('new1'), lesson('new2')];
    const { items, newPaused } = assemble({ ...base, points, states, pool });
    expect(newPaused).toBe(false);
    expect(items.filter((i) => i.kind === 'lesson').map((i) => i.knowledgePointId)).toEqual(['new1']);
    expect(total(items)).toBeLessThanOrEqual(600);
  });

  it(`复习积压超过 ${BACKLOG_SESSIONS} 节的量时暂停新学`, () => {
    // 预算 600 秒 × 3 节 = 1800 秒；31 个 60 秒的到期复习 = 1860 秒
    const reviewPoints = reviewsFor(31);
    const points = [...reviewPoints, point('new1', 100)];
    const states = new Map(reviewPoints.map((p, i) => [p.id, recall(i + 1)]));
    const pool = [...reviewPoints.map((p) => review(p.id)), lesson('new1')];
    const { items, newPaused } = assemble({ ...base, points, states, pool });
    expect(newPaused).toBe(true);
    expect(items.some((i) => i.kind === 'lesson')).toBe(false);
  });

  it('积压刚好等于上限时不暂停新学', () => {
    const reviewPoints = reviewsFor(30);
    const points = [...reviewPoints, point('new1', 100)];
    const states = new Map(reviewPoints.map((p, i) => [p.id, recall(i + 1)]));
    const pool = [...reviewPoints.map((p) => review(p.id)), lesson('new1')];
    expect(assemble({ ...base, points, states, pool }).newPaused).toBe(false);
  });

  it('新知识点只来自认知边缘，且不超过每节上限', () => {
    const points = [point('n1', 1), point('n2', 2), point('n3', 3), point('blocked', 4, ['n1'])];
    const pool = ['n1', 'n2', 'n3', 'blocked'].map((kp) => lesson(kp, 'explain_direct', 100));
    const { items } = assemble({ ...base, points, states: new Map(), pool });
    expect(items.map((i) => i.knowledgePointId)).toEqual(['n1', 'n2']);
  });

  it('复习、推进、新学三类内容穿插排列，而不是分块', () => {
    const points = [point('r1', 1), point('r2', 2), point('u1', 3), point('n1', 4), point('n2', 5)];
    const states = new Map<string, MemoryState>([
      ['r1', recall(5)],
      ['r2', recall(1)],
      ['u1', { ...UNLEARNED, stage: 'understand', lastExplainForm: 'explain_direct' }],
    ]);
    const pool = [
      review('r1'),
      review('r2'),
      lesson('u1', 'explain_analogy', 120),
      lesson('n1', 'explain_direct', 120),
      lesson('n2', 'explain_direct', 120),
    ];
    const { items } = assemble({ ...base, points, states, pool });
    expect(items.map((i) => i.knowledgePointId)).toEqual(['r1', 'u1', 'n1', 'r2', 'n2']);
  });
});
