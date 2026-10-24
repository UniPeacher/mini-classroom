import { State, createEmptyCard } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { masteryBarWidth, masteryHue, masteryOf } from '../../src/domain/mastery';
import { type MemoryState, UNLEARNED } from '../../src/domain/memory';

function at(stage: MemoryState['stage'], stability = 0): MemoryState {
  const card = { ...createEmptyCard(new Date()), state: State.Review, stability };
  return { ...UNLEARNED, stage, card: stability > 0 ? card : null };
}

describe('掌握度', () => {
  it('随掌握阶段单调上升：未学 < 理解 < 推断掌握 ≤ 回忆 < 应用 < 保持', () => {
    const order = [at('unlearned'), at('understand'), at('inferred'), at('recall', 1), at('apply', 10), at('retain', 60)].map(masteryOf);
    for (let i = 1; i < order.length; i++) expect(order[i]!).toBeGreaterThanOrEqual(order[i - 1]!);
    expect(masteryOf(at('unlearned'))).toBe(0);
  });

  it('同一阶段内，记忆越稳定掌握度越高，但不越过下一阶段', () => {
    expect(masteryOf(at('recall', 6))).toBeGreaterThan(masteryOf(at('recall', 1)));
    expect(masteryOf(at('recall', 1000))).toBeLessThan(masteryOf(at('apply', 0.1)));
    expect(masteryOf(at('retain', 1000))).toBe(1);
  });
});

describe('掌握度进度条', () => {
  it('完全没掌握最短，也至少占 1/4；完全掌握占满', () => {
    expect(masteryBarWidth(0)).toBe(0.25);
    expect(masteryBarWidth(1)).toBe(1);
    expect(masteryBarWidth(0.5)).toBeCloseTo(0.625);
  });

  it('完全没掌握是红色，完全掌握是绿色', () => {
    expect(masteryHue(0)).toBeLessThan(15);
    expect(masteryHue(1)).toBeGreaterThan(110);
    expect(masteryHue(1)).toBeLessThan(150);
  });
});
