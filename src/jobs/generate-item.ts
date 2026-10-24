import { randomUUID } from 'node:crypto';
import type { StructuredModel } from '../ai/gateway';
import { type PointContext, generateLesson, generateReview } from '../ai/generators';
import { illustrationPrompt } from '../ai/illustration-style';
import type { MemoryState } from '../domain/memory';
import type { PoolNeed } from '../domain/plan-pool';
import { type IllustrationRequest, type LessonContent, replaceIllustrationRefs } from '../shared/content';
import type { ContentGuidance } from '../shared/content-guidance';
import type { Executor } from '../store/db';
import { type ItemContent, type PointInfo, insertItem } from '../store/repo';
import { illustrations as illustrationTable } from '../store/schema';
import { enqueue } from './queue';

/** 生成好的一项内容，可直接存入候选池 */
export interface GeneratedItem {
  knowledgePointId: string;
  kind: 'lesson' | 'review';
  form: string;
  questionForm: string;
  estSeconds: number;
  content: ItemContent;
  /** 讲解里要画的插画，入库时交给后台去画 */
  illustrations: IllustrationRequest[];
  /** 本次生成使用的引导词，绘图继续使用这一份。 */
  contentGuidance: ContentGuidance;
}

export interface GenerateOptions {
  /** 配置了图像模型时，讲解可以配插画 */
  illustrations: boolean;
  contentGuidance: ContentGuidance;
}

/** 按需要的形式为知识点生成一项内容：讲解 + 当场小题，或复习题 */
export async function generateItem(model: StructuredModel, ctx: PointContext, need: PoolNeed, options: GenerateOptions): Promise<GeneratedItem> {
  if (need.kind === 'lesson') {
    const { estSeconds, illustrations = [], ...content } = await generateLesson(model, ctx, need, options);
    return { knowledgePointId: need.knowledgePointId, kind: 'lesson', form: need.explainForm, questionForm: need.questionForm, estSeconds, content, illustrations, contentGuidance: options.contentGuidance };
  }
  const { estSeconds, ...content } = await generateReview(model, ctx, need.questionForm, options);
  return { knowledgePointId: need.knowledgePointId, kind: 'review', form: need.questionForm, questionForm: need.questionForm, estSeconds, content, illustrations: [], contentGuidance: options.contentGuidance };
}

/**
 * 把生成的内容存入候选池。有插画时为每张建一条记录（含完整提示词）、排队后台去画，
 * 并把正文里的 illustration:key 换成插画的 id，之后在哪里显示这段讲解都能找到图。
 */
export function saveGeneratedItem(db: Executor, { illustrations, contentGuidance, ...item }: GeneratedItem, now: Date): string {
  const ids = new Map(illustrations.map((request) => [request.key, randomUUID()]));
  const content = ids.size ? withIllustrationIds(item.content as LessonContent, ids) : item.content;
  return db.transaction((tx) => {
    const itemId = insertItem(tx, { ...item, content }, now);
    for (const request of illustrations) {
      const id = ids.get(request.key)!;
      tx.insert(illustrationTable).values({ id, itemId, prompt: illustrationPrompt(request, contentGuidance.figureGuidance), createdAt: now }).run();
      enqueue(tx, 'generate_illustration', { illustrationId: id }, now);
    }
    return itemId;
  });
}

function withIllustrationIds(content: LessonContent, ids: Map<string, string>): LessonContent {
  const replace = (text: string) => replaceIllustrationRefs(text, (key) => ids.get(key));
  return { ...content, explanation: replace(content.explanation), ...(content.steps ? { steps: content.steps.map(replace) } : {}) };
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
    learningBrief: point.learningBrief,
    title: point.title,
    summary: point.summary,
    prerequisites: titles(point.prerequisiteIds.filter((id) => !byId.get(id)?.excluded)),
    confusables: titles(point.confusableIds),
    guidance: extras.guidance,
    stage: extras.state?.stage,
    misconception: extras.state?.lastMisconception,
    existingKnowledge: extras.existingKnowledge,
  };
}
