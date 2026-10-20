import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { PoolItem } from '../domain/assemble';
import type { GraphPoint } from '../domain/edge';
import { type MemoryState, reviveCard } from '../domain/memory';
import type { ConnectionContent, Graph, LessonContent, ReviewContent } from '../shared/content';
import type { Executor } from './db';
import { existingKnowledge, items, knowledgePoints, memoryStates, relations, topics } from './schema';

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

/**
 * 拆解：把更基础的前置知识点挂进知识图谱，作为原知识点的前置，并初始化为未学。
 * 它们排在原知识点的推荐位置上，认知边缘会把拆解出的知识点排在前面先教。
 */
export function addDecomposedPoints(
  db: Executor,
  parent: { id: string; topicId: string; position: number },
  points: { title: string; summary: string }[],
  now: Date,
): string[] {
  return db.transaction((tx) =>
    points.map((p) => {
      const id = randomUUID();
      tx.insert(knowledgePoints)
        .values({ id, topicId: parent.topicId, title: p.title, summary: p.summary, position: parent.position, origin: 'decomposed' })
        .run();
      tx.insert(memoryStates).values({ knowledgePointId: id, stage: 'unlearned', updatedAt: now }).run();
      tx.insert(relations).values({ fromId: id, toId: parent.id, type: 'prerequisite' }).run();
      return id;
    }),
  );
}

/** 知识点及生成内容时需要的上下文 */
export interface PointInfo extends GraphPoint {
  topicId: string;
  topicTitle: string;
  title: string;
  summary: string;
  confusableIds: string[];
  /** 组成关系中，它是哪些知识点的一部分 */
  partOfIds: string[];
}

/**
 * 加载所有图谱已生成的主题的知识点。暂停的主题也加载：它的复习照常进行，只是不新学
 * （learnable 为 false）；摸底诊断还没做完的主题同样不新学。
 */
export function loadPoints(db: Executor): PointInfo[] {
  const rows = db
    .select({ point: knowledgePoints, topic: topics })
    .from(knowledgePoints)
    .innerJoin(topics, eq(knowledgePoints.topicId, topics.id))
    .where(eq(topics.graphStatus, 'ready'))
    .all();
  const allRelations = db.select().from(relations).all();
  return rows.map(({ point, topic }) => ({
    id: point.id,
    position: point.position,
    topicId: point.topicId,
    topicTitle: topic.title,
    learnable: topic.status === 'active' && (topic.placementStatus === 'done' || topic.placementStatus === 'skipped'),
    decomposed: point.origin === 'decomposed',
    title: point.title,
    summary: point.summary,
    prerequisiteIds: allRelations.filter((r) => r.type === 'prerequisite' && r.toId === point.id).map((r) => r.fromId),
    confusableIds: allRelations
      .filter((r) => r.type === 'confusable' && (r.fromId === point.id || r.toId === point.id))
      .map((r) => (r.fromId === point.id ? r.toId : r.fromId)),
    partOfIds: allRelations.filter((r) => r.type === 'composition' && r.fromId === point.id).map((r) => r.toId),
  }));
}

export function loadExistingKnowledge(db: Executor) {
  return db.select().from(existingKnowledge).all();
}

// ---------- 记忆状态 ----------

export function loadStates(db: Executor): Map<string, MemoryState> {
  const rows = db.select().from(memoryStates).all();
  return new Map(rows.map((r) => [r.knowledgePointId, rowToState(r)]));
}

function rowToState(r: typeof memoryStates.$inferSelect): MemoryState {
  return {
    stage: r.stage,
    card: reviveCard(r.card),
    lastExplainForm: r.lastExplainForm,
    lastQuestionForm: r.lastQuestionForm,
    failStreak: r.failStreak,
    pendingContrast: r.pendingContrast,
    lastMisconception: r.lastMisconception,
  };
}

export function saveState(db: Executor, knowledgePointId: string, state: MemoryState, now: Date): void {
  db.update(memoryStates)
    .set({
      stage: state.stage,
      card: state.card,
      lastExplainForm: state.lastExplainForm,
      lastQuestionForm: state.lastQuestionForm,
      failStreak: state.failStreak,
      pendingContrast: state.pendingContrast,
      lastMisconception: state.lastMisconception,
      updatedAt: now,
    })
    .where(eq(memoryStates.knowledgePointId, knowledgePointId))
    .run();
}

/** 是否已经拆解过：每个知识点只拆解一次 */
export function wasDecomposed(db: Executor, knowledgePointId: string): boolean {
  const row = db.select({ at: memoryStates.decomposedAt }).from(memoryStates).where(eq(memoryStates.knowledgePointId, knowledgePointId)).get();
  return row?.at != null;
}

export function markDecomposed(db: Executor, knowledgePointId: string, now: Date): void {
  db.update(memoryStates).set({ decomposedAt: now, failStreak: 0 }).where(eq(memoryStates.knowledgePointId, knowledgePointId)).run();
}

// ---------- 候选池 ----------

export type ItemContent = LessonContent | ReviewContent | ConnectionContent;

export function insertItem(
  db: Executor,
  item: { knowledgePointId: string; kind: 'lesson' | 'review' | 'connection'; form: string; questionForm: string; estSeconds: number; content: ItemContent; status?: 'pooled' | 'used' },
  now: Date,
): string {
  const id = randomUUID();
  db.insert(items).values({ id, ...item, createdAt: now }).run();
  return id;
}

/** 候选池中可用的内容（联结练习不进候选池，开始一节时现做） */
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
    .all()
    .filter((i): i is PoolItem => i.kind !== 'connection');
}

export function getItems(db: Executor, ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(items).where(inArray(items.id, ids)).all();
}

export function markItemsUsed(db: Executor, ids: string[]): void {
  if (ids.length === 0) return;
  db.update(items).set({ status: 'used' }).where(inArray(items.id, ids)).run();
}
