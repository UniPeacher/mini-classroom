import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { PoolItem } from '../domain/assemble';
import type { GraphPoint } from '../domain/edge';
import { type MemoryState, reviveCard } from '../domain/memory';
import type { Graph, LessonContent, ReviewContent } from '../shared/content';
import type { Executor } from './db';
import { items, knowledgePoints, memoryStates, relations, topics } from './schema';

// ---------- 学习主题与知识图谱 ----------

export function createTopic(db: Executor, title: string, now: Date): string {
  const id = randomUUID();
  db.insert(topics).values({ id, title, createdAt: now }).run();
  return id;
}

export function getTopic(db: Executor, id: string) {
  return db.select().from(topics).where(eq(topics.id, id)).get();
}

export function markGraphFailed(db: Executor, topicId: string): void {
  db.update(topics).set({ graphStatus: 'failed' }).where(eq(topics.id, topicId)).run();
}

/** 保存骨架图谱：知识点、关系，以及每个知识点的初始记忆状态（未学）。 */
export function saveGraph(db: Executor, topicId: string, graph: Graph, now: Date): void {
  db.transaction((tx) => {
    const idOf = new Map(graph.knowledgePoints.map((k) => [k.key, randomUUID()]));
    graph.knowledgePoints.forEach((k, position) => {
      const id = idOf.get(k.key)!;
      tx.insert(knowledgePoints).values({ id, topicId, title: k.title, summary: k.summary, position }).run();
      tx.insert(memoryStates).values({ knowledgePointId: id, stage: 'unlearned', updatedAt: now }).run();
    });
    for (const r of graph.relations) {
      tx.insert(relations).values({ fromId: idOf.get(r.from)!, toId: idOf.get(r.to)!, type: r.type }).run();
    }
    tx.update(topics).set({ graphStatus: 'ready' }).where(eq(topics.id, topicId)).run();
  });
}

/** 知识点及生成内容时需要的上下文 */
export interface PointInfo extends GraphPoint {
  topicId: string;
  topicTitle: string;
  title: string;
  summary: string;
  confusableIds: string[];
}

/** 加载所有进行中主题的知识点（切片 1 不区分主题优先级）。 */
export function loadPoints(db: Executor): PointInfo[] {
  const rows = db
    .select({ point: knowledgePoints, topicTitle: topics.title })
    .from(knowledgePoints)
    .innerJoin(topics, eq(knowledgePoints.topicId, topics.id))
    .where(and(eq(topics.status, 'active'), eq(topics.graphStatus, 'ready')))
    .all();
  const allRelations = db.select().from(relations).all();
  return rows.map(({ point, topicTitle }) => ({
    id: point.id,
    position: point.position,
    topicId: point.topicId,
    topicTitle,
    title: point.title,
    summary: point.summary,
    prerequisiteIds: allRelations.filter((r) => r.type === 'prerequisite' && r.toId === point.id).map((r) => r.fromId),
    confusableIds: allRelations
      .filter((r) => r.type === 'confusable' && (r.fromId === point.id || r.toId === point.id))
      .map((r) => (r.fromId === point.id ? r.toId : r.fromId)),
  }));
}

// ---------- 记忆状态 ----------

export function loadStates(db: Executor): Map<string, MemoryState> {
  const rows = db.select().from(memoryStates).all();
  return new Map(
    rows.map((r) => [
      r.knowledgePointId,
      { stage: r.stage, card: reviveCard(r.card), lastExplainForm: r.lastExplainForm, lastQuestionForm: r.lastQuestionForm },
    ]),
  );
}

export function saveState(db: Executor, knowledgePointId: string, state: MemoryState, now: Date): void {
  db.update(memoryStates)
    .set({ ...state, updatedAt: now })
    .where(eq(memoryStates.knowledgePointId, knowledgePointId))
    .run();
}

// ---------- 候选池 ----------

export type ItemContent = LessonContent | ReviewContent;

export function insertItem(
  db: Executor,
  item: Omit<PoolItem, 'id'> & { content: ItemContent },
  now: Date,
): string {
  const id = randomUUID();
  db.insert(items).values({ id, ...item, createdAt: now }).run();
  return id;
}

/** 候选池中可用的内容 */
export function loadPool(db: Executor): PoolItem[] {
  return db
    .select({
      id: items.id,
      knowledgePointId: items.knowledgePointId,
      kind: items.kind,
      form: items.form,
      questionForm: items.questionForm,
      estSeconds: items.estSeconds,
    })
    .from(items)
    .where(eq(items.status, 'pooled'))
    .all();
}

export function getItems(db: Executor, ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(items).where(inArray(items.id, ids)).all();
}

export function markItemsUsed(db: Executor, ids: string[]): void {
  if (ids.length === 0) return;
  db.update(items).set({ status: 'used' }).where(inArray(items.id, ids)).run();
}
