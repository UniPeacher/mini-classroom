import { type MemoryState, UNLEARNED, hasLearned } from './memory';

/** 组装和认知边缘计算所需的知识点信息 */
export interface GraphPoint {
  id: string;
  position: number;
  prerequisiteIds: string[];
}

/**
 * 认知边缘：尚未学习、且所有前置都已学过（或没有前置）的知识点，按推荐顺序排列。
 */
export function cognitiveEdge(points: GraphPoint[], states: Map<string, MemoryState>): GraphPoint[] {
  const stageOf = (id: string) => (states.get(id) ?? UNLEARNED).stage;
  return points
    .filter((p) => stageOf(p.id) === 'unlearned')
    .filter((p) => p.prerequisiteIds.every((pre) => hasLearned(stageOf(pre))))
    .sort((a, b) => a.position - b.position);
}
