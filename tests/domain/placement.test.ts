import { describe, expect, it } from 'vitest';
import {
  MAX_PLACEMENT_QUESTIONS,
  type PlacementAnswer,
  type PlacementPoint,
  chooseProbePoints,
  inferKnowledge,
  nextProbe,
  placementResults,
} from '../../src/domain/placement';

// 一条前置链 a → b → c → d → e，另有独立的 x
const chain: PlacementPoint[] = [
  { id: 'a', position: 0, prerequisiteIds: [] },
  { id: 'b', position: 1, prerequisiteIds: ['a'] },
  { id: 'c', position: 2, prerequisiteIds: ['b'] },
  { id: 'd', position: 3, prerequisiteIds: ['c'] },
  { id: 'e', position: 4, prerequisiteIds: ['d'] },
  { id: 'x', position: 5, prerequisiteIds: [] },
];
const all = chain.map((p) => p.id);
const answer = (pointId: string, result: PlacementAnswer['result']): PlacementAnswer => ({ pointId, result });

describe('摸底诊断：推断', () => {
  it('答对某个知识点，它的全部前置推断为已会', () => {
    const { known, unknown } = inferKnowledge(chain, [answer('c', 'correct')]);
    expect([...known].sort()).toEqual(['a', 'b', 'c']);
    expect(unknown.size).toBe(0);
  });

  it('答错或选"不知道"，它的全部后续推断为未学', () => {
    for (const result of ['wrong', 'unknown'] as const) {
      const { known, unknown } = inferKnowledge(chain, [answer('c', result)]);
      expect([...unknown].sort()).toEqual(['c', 'd', 'e']);
      expect(known.size).toBe(0);
    }
  });

  it('推断与直接作答冲突时，以直接作答为准', () => {
    // 答对了 d（推断 c 已会），却答错了 c
    const { known, unknown } = inferKnowledge(chain, [answer('d', 'correct'), answer('c', 'wrong')]);
    expect(known.has('d')).toBe(true);
    expect(unknown.has('c')).toBe(true);
    expect(known.has('c')).toBe(false);
  });
});

describe('摸底诊断：自适应出题', () => {
  it('第一题从背景推断的起点里选最进阶的一个', () => {
    expect(nextProbe(chain, all, [], ['b', 'd'])).toBe('d');
  });

  it('没有起点时，选最能把范围一分为二的题', () => {
    expect(nextProbe(chain, all, [])).toBe('c');
  });

  it('答对后往更难的方向探，答错后往更基础的方向探', () => {
    expect(['d', 'e']).toContain(nextProbe(chain, all, [answer('c', 'correct')]));
    expect(['a', 'b']).toContain(nextProbe(chain, all, [answer('c', 'unknown')]));
  });

  it('已有定论的知识点不再出题；候选题都有定论时结束', () => {
    const answers = [answer('c', 'correct'), answer('e', 'correct'), answer('x', 'correct')];
    expect(nextProbe(chain, all, answers)).toBeNull();
  });

  it(`最多出 ${MAX_PLACEMENT_QUESTIONS} 道题`, () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, position: i, prerequisiteIds: [] }));
    const answers = many.slice(0, MAX_PLACEMENT_QUESTIONS).map((p) => answer(p.id, 'unknown'));
    expect(nextProbe(many, many.map((p) => p.id), answers)).toBeNull();
  });
});

describe('摸底诊断：结果', () => {
  it('直接答对、推断掌握、未学（含没能推断的）三类', () => {
    const results = placementResults(chain, [answer('c', 'correct'), answer('d', 'unknown')]);
    expect(Object.fromEntries(results)).toEqual({ a: 'inferred', b: 'inferred', c: 'correct', d: 'unknown', e: 'unknown', x: 'unknown' });
  });

  it('候选题从基础到进阶均匀覆盖', () => {
    expect(chooseProbePoints(chain, 3)).toEqual(['a', 'c', 'e']);
    expect(chooseProbePoints(chain, 10)).toHaveLength(chain.length);
  });
});
