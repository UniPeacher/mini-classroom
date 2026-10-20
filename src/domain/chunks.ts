import type { Stage } from './memory';

export interface Composition {
  /** 部分 */
  fromId: string;
  /** 整体 */
  toId: string;
}

export interface Chunk {
  /** 整体知识点，组块用它的名字显示 */
  wholeId: string;
  partIds: string[];
}

/**
 * 组块：某个组成关系下的知识点（同一个整体的全部部分）都进入保持阶段后，合并为一块显示。
 * 只影响显示，不改变知识点和记忆状态。
 */
export function chunksOf(stages: Map<string, Stage>, compositions: Composition[]): Chunk[] {
  const partsByWhole = new Map<string, string[]>();
  for (const c of compositions) partsByWhole.set(c.toId, [...(partsByWhole.get(c.toId) ?? []), c.fromId]);
  return [...partsByWhole]
    .filter(([, parts]) => parts.every((id) => stages.get(id) === 'retain'))
    .map(([wholeId, partIds]) => ({ wholeId, partIds }));
}
