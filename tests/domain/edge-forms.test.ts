import { describe, expect, it } from 'vitest';
import { type GraphPoint, cognitiveEdge } from '../../src/domain/edge';
import { EXPLAIN_FORMS, QUESTION_FORMS, nextForm } from '../../src/domain/forms';
import { type MemoryState, UNLEARNED } from '../../src/domain/memory';

const at = (stage: MemoryState['stage']): MemoryState => ({ ...UNLEARNED, stage });

describe('认知边缘', () => {
  // 基础类型 → 泛型 → 泛型约束；联合类型无前置
  const points: GraphPoint[] = [
    { id: 'generic-constraint', position: 3, prerequisiteIds: ['generic'] },
    { id: 'generic', position: 2, prerequisiteIds: ['basic'] },
    { id: 'basic', position: 1, prerequisiteIds: [] },
    { id: 'union', position: 4, prerequisiteIds: [] },
  ];

  it('一开始只有没有前置的知识点在边缘，按推荐顺序排列', () => {
    expect(cognitiveEdge(points, new Map()).map((p) => p.id)).toEqual(['basic', 'union']);
  });

  it('前置还在理解阶段时，后续知识点不在边缘', () => {
    const states = new Map([['basic', at('understand')]]);
    expect(cognitiveEdge(points, states).map((p) => p.id)).toEqual(['union']);
  });

  it('前置进入回忆阶段后，后续知识点进入边缘；已学的不在边缘', () => {
    const states = new Map([['basic', at('recall')]]);
    expect(cognitiveEdge(points, states).map((p) => p.id)).toEqual(['generic', 'union']);
  });
});

describe('形式轮换', () => {
  it('没有上次记录时取第一种', () => {
    expect(nextForm(QUESTION_FORMS, null)).toBe('mcq');
  });

  it('总是与上次不同，并循环轮换', () => {
    expect(nextForm(QUESTION_FORMS, 'mcq')).toBe('short_answer');
    expect(nextForm(QUESTION_FORMS, 'short_answer')).toBe('mcq');
    expect(nextForm(EXPLAIN_FORMS, 'explain_counterexample')).toBe('explain_direct');
  });
});
