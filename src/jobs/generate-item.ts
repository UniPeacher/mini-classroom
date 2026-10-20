import type { StructuredModel } from '../ai/gateway';
import { type PointContext, generateLesson, generateReview } from '../ai/generators';
import type { MemoryState } from '../domain/memory';
import type { PoolNeed } from '../domain/plan-pool';
import type { ItemContent, PointInfo } from '../store/repo';

/** 生成好的一项内容，可直接存入候选池 */
export interface GeneratedItem {
  knowledgePointId: string;
  kind: 'lesson' | 'review';
  form: string;
  questionForm: string;
  estSeconds: number;
  content: ItemContent;
}

/** 按需要的形式为知识点生成一项内容：讲解 + 当场小题，或复习题 */
export async function generateItem(model: StructuredModel, ctx: PointContext, need: PoolNeed): Promise<GeneratedItem> {
  if (need.kind === 'lesson') {
    const { estSeconds, ...content } = await generateLesson(model, ctx, need);
    return { knowledgePointId: need.knowledgePointId, kind: 'lesson', form: need.explainForm, questionForm: need.questionForm, estSeconds, content };
  }
  const { estSeconds, ...content } = await generateReview(model, ctx, need.questionForm);
  return { knowledgePointId: need.knowledgePointId, kind: 'review', form: need.questionForm, questionForm: need.questionForm, estSeconds, content };
}

export interface ContextExtras {
  /** 学习者为这一节写的补充说明 */
  guidance?: string;
  /** 记忆状态：阶段决定复习题考到什么程度，误解内容用于对比讲解 */
  state?: MemoryState;
  /** 学习者的已有知识 */
  existingKnowledge?: string[];
}

/** 生成内容时给模型的知识点上下文 */
export function contextOf(point: PointInfo, byId: Map<string, PointInfo>, extras: ContextExtras = {}): PointContext {
  const titles = (ids: string[]) => ids.map((id) => byId.get(id)?.title).filter((t): t is string => t !== undefined);
  return {
    topicTitle: point.topicTitle,
    title: point.title,
    summary: point.summary,
    prerequisites: titles(point.prerequisiteIds),
    confusables: titles(point.confusableIds),
    guidance: extras.guidance,
    stage: extras.state?.stage,
    misconception: extras.state?.lastMisconception,
    existingKnowledge: extras.existingKnowledge,
  };
}
