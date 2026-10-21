import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { StructuredModel } from '../ai/gateway';
import { type AskContext, answerQuestion, suggestKnowledge } from '../ai/generators';
import { enqueue } from '../jobs/queue';
import type { LessonContent, Question } from '../shared/content';
import type { Db } from '../store/db';
import { addPoints, getItems, loadPoints } from '../store/repo';
import { asks, attempts, sessionItems } from '../store/schema';
import { LearningError, questionOf } from './views';

export interface AskingDeps {
  db: Db;
  model: StructuredModel;
}

/** 每次提问带上本节最近几轮问答，回答能接着上文 */
const HISTORY_TURNS = 4;

/**
 * 学习时随时提问：AI 结合正在学的这一项来回答；小题作答前只引导、不给答案。
 * 问过之后，可以从提问中整理出还不了解的知识，由用户确认后加入认知地图，之后的微课堂会安排学习。
 */
export function createAsking({ db, model }: AskingDeps) {
  /** 提问并得到回答；itemId 为正在学的那一项（可选） */
  async function ask(input: { sessionId: string; itemId?: string; question: string }, now: Date) {
    const item = input.itemId ? requireSessionItem(input.sessionId, input.itemId) : null;
    const history = listAsks(input.sessionId).slice(-HISTORY_TURNS);
    const answer = await answerQuestion(model, item ? contextOf(item) : null, {
      question: input.question,
      history: history.map((a) => ({ question: a.question, answer: a.answer })),
    });
    const id = randomUUID();
    const row = { id, sessionId: input.sessionId, knowledgePointId: item?.knowledgePointId ?? null, question: input.question, answer, createdAt: now };
    db.insert(asks).values(row).run();
    return row;
  }

  /** 这一节里的全部问答，按时间顺序（刷新页面后恢复对话） */
  function listAsks(sessionId: string) {
    return db.select().from(asks).where(eq(asks.sessionId, sessionId)).orderBy(asc(asks.createdAt)).all();
  }

  /**
   * 从这一节的提问中整理出还不了解的知识，作为加入认知地图的建议（不直接写入）。
   * 以提问最多的那个知识点为锚点：新知识点加到它所在的主题，缺的基础挂成它的前置。
   */
  async function suggest(sessionId: string) {
    const rows = listAsks(sessionId);
    if (rows.length === 0) throw new LearningError('这一节还没有提问', 400);
    const anchorId = mostAskedPoint(rows);
    const points = loadPoints(db);
    const anchor = points.find((p) => p.id === anchorId);
    if (!anchor) throw new LearningError('提问时没有在学的知识点，无法确定加到哪个主题', 400);
    const suggestions = await suggestKnowledge(
      model,
      { topicTitle: anchor.topicTitle, title: anchor.title, summary: anchor.summary, existingTitles: points.filter((p) => p.topicId === anchor.topicId).map((p) => p.title) },
      rows.map((r) => ({ question: r.question, answer: r.answer })),
    );
    const existing = new Set(points.filter((p) => p.topicId === anchor.topicId).map((p) => p.title.trim()));
    return {
      anchor: { id: anchor.id, title: anchor.title, topicId: anchor.topicId, topicTitle: anchor.topicTitle },
      suggestions: suggestions.filter((s) => !existing.has(s.title.trim())),
    };
  }

  /** 把用户确认的知识点加入认知地图：未学，之后的微课堂按认知顺序安排 */
  function accept(input: { anchorPointId: string; points: { title: string; summary: string; kind: 'prerequisite' | 'extension' }[] }, now: Date) {
    const points = loadPoints(db);
    const anchor = points.find((p) => p.id === input.anchorPointId);
    if (!anchor) throw new LearningError('知识点不存在', 404);
    const existing = new Set(points.filter((p) => p.topicId === anchor.topicId).map((p) => p.title.trim()));
    const fresh = input.points.filter((p) => !existing.has(p.title.trim()));
    const ids = addPoints(db, anchor, fresh.map((p) => ({ title: p.title, summary: p.summary, prerequisite: p.kind === 'prerequisite' })), 'asked', now);
    if (ids.length > 0) enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
    return { added: ids.length, skipped: input.points.length - fresh.length, topicId: anchor.topicId };
  }

  // ---------- 内部 ----------

  function requireSessionItem(sessionId: string, itemId: string) {
    const link = db.select().from(sessionItems).where(eq(sessionItems.itemId, itemId)).all().find((l) => l.sessionId === sessionId);
    if (!link) throw new LearningError('这一项不属于本节', 404);
    return getItems(db, [itemId])[0]!;
  }

  /** 提问的上下文：知识点、讲解原文、当前小题（不含答案）以及是否已作答 */
  function contextOf(item: ReturnType<typeof getItems>[number]): AskContext {
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

  return { ask, listAsks, suggest, accept };
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
