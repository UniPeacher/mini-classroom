import { type MemoryState, type Stage, UNLEARNED, hasLearned } from './memory';

/** 组装和认知边缘计算所需的知识点信息 */
export interface GraphPoint {
  id: string;
  position: number;
  prerequisiteIds: string[];
  /** 所属学习主题；每节的新知识点只来自一个主题 */
  topicId?: string;
  /** 所属主题此刻能否新学：主题暂停、或摸底诊断还没完成时为 false。缺省为 true */
  learnable?: boolean;
  /** 拆解出的更基础的前置知识点：在认知边缘上排在前面，先教 */
  decomposed?: boolean;
}

/** 前置知识点是否都已学过（或没有前置） */
export function prerequisitesLearned(point: GraphPoint, stageOf: (id: string) => Stage): boolean {
  return point.prerequisiteIds.every((pre) => hasLearned(stageOf(pre)));
}

/**
 * 认知边缘：尚未学习、且所有前置都已学过（或没有前置）的知识点。
 * 只取能新学的主题；拆解出的前置知识点排在前面，其余按推荐顺序。
 */
export function cognitiveEdge(points: GraphPoint[], states: Map<string, MemoryState>): GraphPoint[] {
  const stageOf = (id: string) => (states.get(id) ?? UNLEARNED).stage;
  return points
    .filter((p) => p.learnable !== false && stageOf(p.id) === 'unlearned')
    .filter((p) => prerequisitesLearned(p, stageOf))
    .sort((a, b) => Number(b.decomposed ?? false) - Number(a.decomposed ?? false) || a.position - b.position);
}
