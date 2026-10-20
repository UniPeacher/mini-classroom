import { describe, expect, it } from 'vitest';
import { type GraphPoint, cognitiveEdge } from '../../src/domain/edge';
import { CORE_FORMS, EXPLAIN_FORMS, STAGE_QUESTION_FORMS, explainFormsFor, nextForm, pickForm, questionFormsFor } from '../../src/domain/forms';
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
  const recall = STAGE_QUESTION_FORMS.recall.forms;

  it('没有上次记录时取第一种', () => {
    expect(nextForm(recall, null)).toBe('mcq');
  });

  it('总是与上次不同，并循环轮换', () => {
    expect(nextForm(recall, 'mcq')).toBe('short_answer');
    expect(nextForm(recall, 'pick_line')).toBe('mcq');
    expect(nextForm(EXPLAIN_FORMS, EXPLAIN_FORMS.at(-1)!)).toBe('explain_direct');
  });

  it('调高偏好的形式优先，但不与上次重复', () => {
    expect(pickForm(EXPLAIN_FORMS, null, ['explain_diagram'])).toBe('explain_diagram');
    expect(pickForm(EXPLAIN_FORMS, 'explain_diagram', ['explain_diagram'])).toBe('explain_steps');
  });

  it('只有一种可用时，即使与上次相同也用它', () => {
    expect(pickForm(['fix'], 'fix')).toBe('fix');
  });
});

describe('形式偏好', () => {
  it('各掌握阶段有自己的形式池：应用阶段是补全、修正、找错', () => {
    expect(questionFormsFor('apply', { blocked: [], boosted: [] })).toEqual(['fix', 'complete', 'pick_line']);
  });

  it('屏蔽的形式不再出现，但核心检验形式屏蔽不掉', () => {
    const prefs = { blocked: ['pick_line', 'fix', 'complete'], boosted: [] };
    expect(questionFormsFor('apply', prefs)).toEqual(['fix']);
    expect(questionFormsFor('recall', prefs)).toEqual(['mcq', 'short_answer']);
    expect(CORE_FORMS).toContain('fix');
  });

  it('手机上只出适合手机的形式：应用阶段只剩点选错误行', () => {
    expect(questionFormsFor('apply', { blocked: [], boosted: [] }, true)).toEqual(['pick_line']);
  });

  it('手机上可用的形式都被屏蔽时，退回适合手机的选择题', () => {
    expect(questionFormsFor('apply', { blocked: ['pick_line'], boosted: [] }, true)).toEqual(['mcq']);
  });

  it('讲解形式全部屏蔽时退回直接讲解', () => {
    expect(explainFormsFor({ blocked: [...EXPLAIN_FORMS], boosted: [] })).toEqual(['explain_direct']);
  });
});
