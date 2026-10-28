import { type MemoryState, type Stage, UNLEARNED, hasLearned } from './memory';

/** 组装和认知边缘计算所需的知识点信息 */
export interface GraphPoint {
  id: string;
  position: number;
  prerequisiteIds: string[];
  /** 所属学习主题；每节的新知识点只来自一个主题 */
  topicId?: string;
  /** 所属主题的学科标签；未归类时为 null。按学科学习时据此限定范围 */
  subject?: string | null;
  /** 所属主题此刻能否新学：主题暂停、或摸底诊断还没完成时为 false。缺省为 true */
  learnable?: boolean;
  /** 用户选择不学：停止所有学习安排，保留真实掌握阶段。缺省为 false */
  excluded?: boolean;
  /** 拆解出的更基础的前置知识点：在认知边缘上排在前面，先教 */
  decomposed?: boolean;
}

/** 前置已学过或明确选择不学，即可继续后续内容；不学不等于掌握。 */
export function prerequisitesSatisfied(point: GraphPoint, stageOf: (id: string) => Stage, excludedIds: Set<string>): boolean {
  return point.prerequisiteIds.every((pre) => excludedIds.has(pre) || hasLearned(stageOf(pre)));
}

/**
 * 认知边缘：尚未学习、且前置均已学过或选择不学的知识点。
 * 只取能新学的主题；拆解出的前置知识点排在前面，其余按推荐顺序。
 */
export function cognitiveEdge(points: GraphPoint[], states: Map<string, MemoryState>): GraphPoint[] {
  const stageOf = (id: string) => (states.get(id) ?? UNLEARNED).stage;
  const excludedIds = new Set(points.filter((p) => p.excluded).map((p) => p.id));
  return points
    .filter((p) => !p.excluded && p.learnable !== false && stageOf(p.id) === 'unlearned')
    .filter((p) => prerequisitesSatisfied(p, stageOf, excludedIds))
    .sort((a, b) => Number(b.decomposed ?? false) - Number(a.decomposed ?? false) || a.position - b.position);
}
