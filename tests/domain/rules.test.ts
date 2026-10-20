import { describe, expect, it } from 'vitest';
import { MIN_SAMPLES, timeFactor } from '../../src/domain/calibration';
import { chunksOf } from '../../src/domain/chunks';
import { cognitiveEdge } from '../../src/domain/edge';
import { type MemoryState, UNLEARNED } from '../../src/domain/memory';
import { chooseNewTopic, revisitDue } from '../../src/domain/topics';

const DAY = 24 * 3600 * 1000;

describe('新学按主题轮换', () => {
  const topic = (topicId: string, priority: number, servedSessions: number, createdAt = 0) => ({ topicId, priority, servedSessions, createdAt });

  it('优先级相同时，轮到供给新学最少的主题', () => {
    expect(chooseNewTopic([topic('a', 1, 3), topic('b', 1, 2)])).toBe('b');
  });

  it('优先级高的主题得到更多新学机会：高优先级供给 2 节后，仍先于低优先级供给 1 节的', () => {
    expect(chooseNewTopic([topic('high', 3, 2), topic('low', 1, 1)])).toBe('high');
    expect(chooseNewTopic([topic('high', 3, 4), topic('low', 1, 1)])).toBe('low');
  });

  it('都没供给过时，优先级高的先；再相同时先建的先', () => {
    expect(chooseNewTopic([topic('a', 1, 0), topic('b', 2, 0)])).toBe('b');
    expect(chooseNewTopic([topic('later', 1, 0, 2), topic('earlier', 1, 0, 1)])).toBe('earlier');
  });

  it('没有可新学的主题时返回 null', () => {
    expect(chooseNewTopic([])).toBeNull();
  });
});

describe('主题回访', () => {
  const now = new Date('2026-10-20T12:00:00Z');

  it('有暂停的主题、且从未回访过时回访', () => {
    expect(revisitDue(null, now, 14, 1)).toBe(true);
  });

  it('距上次回访不足间隔时不回访，满间隔时回访', () => {
    expect(revisitDue(new Date(now.getTime() - 13 * DAY), now, 14, 1)).toBe(false);
    expect(revisitDue(new Date(now.getTime() - 14 * DAY), now, 14, 1)).toBe(true);
  });

  it('没有暂停的主题时不回访', () => {
    expect(revisitDue(null, now, 14, 0)).toBe(false);
  });
});

describe('时长校准', () => {
  const sample = (estSeconds: number, actualSeconds: number) => ({ estSeconds, durationMs: actualSeconds * 1000 });

  it(`作答少于 ${MIN_SAMPLES} 次时不校准`, () => {
    expect(timeFactor([sample(60, 120), sample(60, 120)])).toBe(1);
  });

  it('按"实际 ÷ 预估"的中位数校准：偶尔一次中途离开不会把系数拉偏', () => {
    const samples = [sample(60, 90), sample(60, 90), sample(60, 90), sample(60, 90), sample(60, 3600)];
    expect(timeFactor(samples)).toBeCloseTo(1.5);
  });

  it('系数限制在 0.5~2 倍', () => {
    expect(timeFactor(Array.from({ length: 5 }, () => sample(60, 600)))).toBe(2);
    expect(timeFactor(Array.from({ length: 5 }, () => sample(60, 5)))).toBe(0.5);
  });
});

describe('组块', () => {
  const compositions = [
    { fromId: 'partial', toId: 'utility' },
    { fromId: 'pick', toId: 'utility' },
    { fromId: 'record', toId: 'utility' },
    { fromId: 'keyof', toId: 'operators' },
  ];

  it('同一整体的部分全部进入保持阶段后，合并为一块', () => {
    const stages = new Map<string, MemoryState['stage']>([
      ['partial', 'retain'],
      ['pick', 'retain'],
      ['record', 'retain'],
      ['keyof', 'apply'],
    ]);
    expect(chunksOf(stages, compositions)).toEqual([{ wholeId: 'utility', partIds: ['partial', 'pick', 'record'] }]);
  });

  it('只要有一个部分还没进入保持阶段，就不合并', () => {
    const stages = new Map<string, MemoryState['stage']>([
      ['partial', 'retain'],
      ['pick', 'retain'],
      ['record', 'recall'],
    ]);
    expect(chunksOf(stages, compositions)).toEqual([]);
  });
});

describe('认知边缘：多主题与拆解', () => {
  it('暂停或摸底未完成的主题，知识点不进入认知边缘', () => {
    const points = [
      { id: 'a', position: 0, prerequisiteIds: [], learnable: true },
      { id: 'b', position: 1, prerequisiteIds: [], learnable: false },
    ];
    expect(cognitiveEdge(points, new Map()).map((p) => p.id)).toEqual(['a']);
  });

  it('推断掌握的前置视同学过', () => {
    const points = [
      { id: 'basic', position: 0, prerequisiteIds: [] },
      { id: 'next', position: 1, prerequisiteIds: ['basic'] },
    ];
    const states = new Map<string, MemoryState>([['basic', { ...UNLEARNED, stage: 'inferred' }]]);
    expect(cognitiveEdge(points, states).map((p) => p.id)).toEqual(['next']);
  });

  it('拆解出的前置知识点排在前面先教', () => {
    const points = [
      { id: 'early', position: 0, prerequisiteIds: [] },
      { id: 'decomposed', position: 5, prerequisiteIds: [], decomposed: true },
    ];
    expect(cognitiveEdge(points, new Map()).map((p) => p.id)).toEqual(['decomposed', 'early']);
  });
});
