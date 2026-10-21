import { randomUUID } from 'node:crypto';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { StructuredModel } from '../ai/gateway';
import { type AskContext, answerQuestion, suggestKnowledge } from '../ai/generators';
import { enqueue } from '../jobs/queue';
import type { LessonContent, Question } from '../shared/content';
import type { Db } from '../store/db';
import { addPoints, getItems, loadPoints } from '../store/repo';
import { askThreads, asks, attempts, items, sessionItems } from '../store/schema';
import { LearningError, questionOf } from './views';

export interface AskingDeps {
  db: Db;
  model: StructuredModel;
}

/** 每次提问带上本会话最近几轮问答，回答能接着上文 */
const HISTORY_TURNS = 4;

/** 提问在哪里发生：学习页的某一节（及正在学的那一项），或认知地图、回看页里正在看的知识点 */
export interface AskScope {
  sessionId?: string;
  pointId?: string;
}

/**
 * 学习时随时提问：按会话组织，新建会话后不再带上之前的上下文。
 * AI 结合正在学的这一项（或正在看的知识点）和选中的内容来回答；小题作答前只引导、不给答案。
 * 可以从一个会话的提问中整理出还不了解的知识，用户逐个点选加入认知地图，之后的微课堂会安排学习。
 */
export function createAsking({ db, model }: AskingDeps) {
  function createThread(scope: AskScope, now: Date) {
    const id = randomUUID();
    const row = { id, sessionId: scope.sessionId ?? null, knowledgePointId: scope.pointId ?? null, createdAt: now };
    db.insert(askThreads).values(row).run();
    return { ...row, asks: [] as (typeof asks.$inferSelect)[] };
  }

  /** 某处的全部会话（最新的在前），各带问答记录 */
  function listThreads(scope: AskScope) {
    const filter = scope.sessionId ? eq(askThreads.sessionId, scope.sessionId) : scope.pointId ? eq(askThreads.knowledgePointId, scope.pointId) : undefined;
    if (!filter) throw new LearningError('需要指定在哪一节或哪个知识点提问', 400);
    // 同一时刻建的会话按插入顺序（rowid）排，保证顺序确定
    const threads = db.select().from(askThreads).where(filter).orderBy(desc(askThreads.createdAt), desc(sql`rowid`)).all();
    return threads.map((t) => ({ ...t, asks: asksOf(t.id) }));
  }

  /** 在会话里提问并得到回答；itemId 为学习页正在学的那一项，pointId 为正在看的知识点，quote 为选中的内容 */
  async function ask(input: { threadId: string; itemId?: string; pointId?: string; quote?: string; question: string }, now: Date) {
    const thread = requireThread(input.threadId);
    const item = input.itemId && thread.sessionId ? requireSessionItem(thread.sessionId, input.itemId) : null;
    const pointId = item?.knowledgePointId ?? input.pointId ?? thread.knowledgePointId;
    const history = asksOf(thread.id).slice(-HISTORY_TURNS);
    const answer = await answerQuestion(model, item ? itemContext(item) : pointId ? pointContext(pointId) : null, {
      question: input.question,
      quote: input.quote,
      history: history.map((a) => ({ question: a.quote ? `关于「${a.quote}」：${a.question}` : a.question, answer: a.answer })),
    });
    const row = {
      id: randomUUID(),
      threadId: thread.id,
      sessionId: thread.sessionId,
      knowledgePointId: pointId ?? null,
      quote: input.quote ?? null,
      question: input.question,
      answer,
      createdAt: now,
    };
    db.insert(asks).values(row).run();
    return row;
  }

  /**
   * 从一个会话的提问中整理出还不了解的知识，作为加入认知地图的候选（不直接写入）。
   * 以会话里提问最多的知识点为锚点：新知识点加到它所在的主题，缺的基础挂成它的前置。
   */
  async function suggest(threadId: string) {
    const thread = requireThread(threadId);
    const rows = asksOf(thread.id);
    if (rows.length === 0) throw new LearningError('这个会话还没有提问', 400);
    const anchorId = mostAskedPoint(rows) ?? thread.knowledgePointId;
    const points = loadPoints(db);
    const anchor = points.find((p) => p.id === anchorId);
    if (!anchor) throw new LearningError('提问时没有在学的知识点，无法确定加到哪个主题', 400);
    const sameTopic = points.filter((p) => p.topicId === anchor.topicId);
    const suggestions = await suggestKnowledge(
      model,
      { topicTitle: anchor.topicTitle, title: anchor.title, summary: anchor.summary, existingTitles: sameTopic.map((p) => p.title) },
      rows.map((r) => ({ question: r.quote ? `关于「${r.quote}」：${r.question}` : r.question, answer: r.answer })),
    );
    const existing = new Set(sameTopic.map((p) => p.title.trim()));
    return {
      anchor: { id: anchor.id, title: anchor.title, topicId: anchor.topicId, topicTitle: anchor.topicTitle },
      suggestions: suggestions.filter((s) => !existing.has(s.title.trim())),
    };
  }

  /** 把用户点选的知识点加入认知地图：未学，之后的微课堂按认知顺序安排 */
  function accept(input: { anchorPointId: string; points: { title: string; summary: string; kind: 'prerequisite' | 'extension' }[] }, now: Date) {
    const points = loadPoints(db);
    const anchor = points.find((p) => p.id === input.anchorPointId);
    if (!anchor) throw new LearningError('知识点不存在', 404);
    const existing = new Set(points.filter((p) => p.topicId === anchor.topicId).map((p) => p.title.trim()));
    const fresh = input.points.filter((p) => !existing.has(p.title.trim()));
    const ids = addPoints(db, anchor, fresh.map((p) => ({ title: p.title, summary: p.summary, prerequisite: p.kind === 'prerequisite' })), 'asked', now);
    if (ids.length > 0) enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
    return { added: ids.length, skipped: input.points.length - fresh.length, topicId: anchor.topicId, pointIds: ids };
  }

  // ---------- 内部 ----------

  function requireThread(threadId: string) {
    const thread = db.select().from(askThreads).where(eq(askThreads.id, threadId)).get();
    if (!thread) throw new LearningError('会话不存在', 404);
    return thread;
  }

  function asksOf(threadId: string) {
    return db.select().from(asks).where(eq(asks.threadId, threadId)).orderBy(asc(asks.createdAt), asc(sql`rowid`)).all();
  }

  function requireSessionItem(sessionId: string, itemId: string) {
    const link = db.select().from(sessionItems).where(eq(sessionItems.itemId, itemId)).all().find((l) => l.sessionId === sessionId);
    if (!link) throw new LearningError('这一项不属于本节', 404);
    return getItems(db, [itemId])[0]!;
  }

  /** 学习页的上下文：知识点、讲解原文、当前小题（不含答案）以及是否已作答 */
  function itemContext(item: ReturnType<typeof getItems>[number]): AskContext {
    const point = loadPoints(db).find((p) => p.id === item.knowledgePointId);
    const question = questionOf(item);
    const answered = db.select({ id: attempts.id }).from(attempts).where(eq(attempts.itemId, item.id)).all().length > 0;
    return {
      topicTitle: point?.topicTitle ?? '',
      title: point?.title ?? '',
      summary: point?.summary ?? '',
      explanation: item.kind === 'lesson' ? (item.content as LessonContent).explanation : null,
      questionText: question ? questionText(question) : null,
      answered,
    };
  }

  /** 认知地图、回看页的上下文：知识点和最近一次学过的讲解 */
  function pointContext(pointId: string): AskContext | null {
    const point = loadPoints(db).find((p) => p.id === pointId);
    if (!point) return null;
    const lesson = db
      .select({ content: items.content })
      .from(attempts)
      .innerJoin(items, eq(attempts.itemId, items.id))
      .where(eq(items.knowledgePointId, pointId))
      .orderBy(desc(attempts.createdAt))
      .all()
      .find((r) => (r.content as Partial<LessonContent>).explanation !== undefined);
    return {
      topicTitle: point.topicTitle,
      title: point.title,
      summary: point.summary,
      explanation: (lesson?.content as LessonContent | undefined)?.explanation ?? null,
      questionText: null,
      answered: true,
    };
  }

  return { createThread, listThreads, ask, suggest, accept };
}

export type Asking = ReturnType<typeof createAsking>;

/** 题面（不含答案），给模型看学习者正在答什么 */
function questionText(question: Question): string {
  switch (question.type) {
    case 'mcq':
      return `${question.stem}\n${question.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o.text}`).join('\n')}`;
    case 'pick_line':
      return `${question.prompt}\n${question.lines.map((l, i) => `${i + 1}  ${l}`).join('\n')}`;
    case 'complete':
      return `${question.prompt}\n${question.template}`;
    case 'fix':
      return `${question.prompt}\n${question.flawed}`;
    case 'short_answer':
      return question.prompt;
  }
}

/** 提问最多的知识点；一样多时取最近一次提问的 */
function mostAskedPoint(rows: { knowledgePointId: string | null }[]): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.knowledgePointId) counts.set(r.knowledgePointId, (counts.get(r.knowledgePointId) ?? 0) + 1);
  let best: string | null = null;
  for (const r of [...rows].reverse()) {
    if (!r.knowledgePointId) continue;
    if (best === null || (counts.get(r.knowledgePointId) ?? 0) > (counts.get(best) ?? 0)) best = r.knowledgePointId;
  }
  return best;
}
