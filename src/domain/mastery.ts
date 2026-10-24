import type { MemoryState } from './memory';

/** 记忆稳定性达到这么多天，算作这一阶段内已经练稳 */
const STEADY_DAYS = { recall: 7, apply: 30, retain: 90 } as const;

const steadiness = (stability: number, days: number) => Math.min(1, Math.max(0, stability / days));

/**
 * 掌握度（0~1），用于认知地图卡片底部的进度条：由掌握阶段决定区间，阶段内按记忆稳定性细分。
 * - 未学 0；理解（学过但小题还没答对）0.15；推断掌握 0.35；
 * - 回忆 0.35~0.55、应用 0.6~0.85、保持 0.9~1：记忆越稳定越靠上。
 */
export function masteryOf(state: MemoryState): number {
  const stability = state.card?.stability ?? 0;
  switch (state.stage) {
    case 'unlearned':
      return 0;
    case 'understand':
      return 0.15;
    case 'inferred':
      return 0.35;
    case 'recall':
      return 0.35 + 0.2 * steadiness(stability, STEADY_DAYS.recall);
    case 'apply':
      return 0.6 + 0.25 * steadiness(stability, STEADY_DAYS.apply);
    case 'retain':
      return 0.9 + 0.1 * steadiness(stability, STEADY_DAYS.retain);
  }
}

/** 进度条的长度（占卡片宽度的比例）：最短 1/4，掌握度越高越长，完全掌握时占满 */
export function masteryBarWidth(mastery: number): number {
  return 0.25 + 0.75 * Math.min(1, Math.max(0, mastery));
}

/** 进度条的颜色：完全没掌握是红色，越掌握越偏向绿色（色相 4° → 130°） */
export function masteryHue(mastery: number): number {
  return Math.round(4 + 126 * Math.min(1, Math.max(0, mastery)));
}
