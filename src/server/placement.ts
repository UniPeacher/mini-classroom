import { eq } from 'drizzle-orm';
import { fromPlacement } from '../domain/memory';
import { MAX_PLACEMENT_QUESTIONS, type PlacementAnswer, nextProbe, placementResults } from '../domain/placement';
import { enqueue } from '../jobs/queue';
import type { Mcq } from '../shared/content';
import type { Db } from '../store/db';
import { getTopic, loadPoints, loadStates, saveState } from '../store/repo';
import { placements, topics } from '../store/schema';
import { LearningError } from './views';

export interface PlacementDeps {
  db: Db;
}

/** 预先生成的一道摸底题 */
interface Probe {
  pointId: string;
  question: Mcq;
}

/** 一道摸底题的作答；choice 为 -1 表示"不知道" */
interface StoredAnswer extends PlacementAnswer {
  choice: number;
}

/** 选"不知道"时提交的序号 */
export const UNKNOWN_CHOICE = -1;

/**
 * 摸底诊断：开始一个学习主题时约 3 分钟的短测。
 * 先由用户用一两句话自述背景（得到已有知识，也确定起点），后台为候选知识点各备一道选择题；
 * 再顺着前置关系自适应地出 8~10 道，每题都有"不知道"。做完后按结果设定初始掌握状态。
 */
export function createPlacement({ db }: PlacementDeps) {
  /** 提交背景自述，后台准备摸底题 */
  function begin(topicId: string, background: string, now: Date) {
    const topic = requireTopic(topicId);
    if (topic.graphStatus !== 'ready') throw new LearningError('知识图谱还没生成好，请稍后再开始摸底', 409);
    if (topic.placementStatus !== 'pending') throw new LearningError('这个主题的摸底已经开始或结束了', 409);
    db.transaction((tx) => {
      tx.insert(placements)
        .values({ topicId, background, startIds: [], probes: [], answers: [], createdAt: now })
        .onConflictDoUpdate({ target: placements.topicId, set: { background, startIds: [], probes: [], answers: [], createdAt: now } })
        .run();
      tx.update(topics).set({ placementStatus: 'preparing' }).where(eq(topics.id, topicId)).run();
    });
    enqueue(db, 'prepare_placement', { topicId }, now);
    return status(topicId);
  }

  /** 跳过摸底：所有知识点从未学开始 */
  function skip(topicId: string, now: Date) {
    const topic = requireTopic(topicId);
    if (topic.placementStatus === 'done' || topic.placementStatus === 'skipped') return status(topicId);
    db.update(topics).set({ placementStatus: 'skipped' }).where(eq(topics.id, topicId)).run();
    enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
    return status(topicId);
  }

  /** 摸底进度：准备中、下一道题（不含答案），或结束后的结果 */
  function status(topicId: string) {
    const topic = requireTopic(topicId);
    const placement = db.select().from(placements).where(eq(placements.topicId, topicId)).get();
    const answers = (placement?.answers as StoredAnswer[] | undefined) ?? [];
    const base = {
      topicId,
      topicTitle: topic.title,
      status: topic.placementStatus,
      // 准备过但失败了：退回待开始，背景自述还在
      background: placement?.background ?? null,
      answered: answers.length,
      maxQuestions: MAX_PLACEMENT_QUESTIONS,
      question: null as { pointId: string; title: string; stem: string; options: string[] } | null,
      summary: null as { correct: number; inferred: number; unknown: number } | null,
    };
    if (topic.placementStatus === 'testing' && placement) {
      const next = currentProbe(topicId);
      if (next) {
        const title = loadPoints(db).find((p) => p.id === next.pointId)?.title ?? '';
        base.question = { pointId: next.pointId, title, stem: next.question.stem, options: next.question.options.map((o) => o.text) };
      }
    }
    if (topic.placementStatus === 'done') base.summary = summarize(topicId, answers);
    return base;
  }

  /** 回答当前这道摸底题；出满题数或没有可推断的题时结束，并设定初始掌握状态 */
  function answer(topicId: string, pointId: string, choice: number, now: Date) {
    const topic = requireTopic(topicId);
    if (topic.placementStatus !== 'testing') throw new LearningError('摸底还没开始或已经结束', 409);
    const probe = currentProbe(topicId);
    if (!probe || probe.pointId !== pointId) throw new LearningError('这道题不是当前要回答的题', 409);
    const result: PlacementAnswer['result'] =
      choice === UNKNOWN_CHOICE ? 'unknown' : choice === probe.question.answerIndex ? 'correct' : 'wrong';
    const placement = db.select().from(placements).where(eq(placements.topicId, topicId)).get()!;
    const answers = [...(placement.answers as StoredAnswer[]), { pointId, choice, result }];
    db.update(placements).set({ answers }).where(eq(placements.topicId, topicId)).run();
    if (!currentProbe(topicId)) finish(topicId, answers, now);
    return status(topicId);
  }

  // ---------- 内部 ----------

  function requireTopic(topicId: string) {
    const topic = getTopic(db, topicId);
    if (!topic) throw new LearningError('学习主题不存在', 404);
    return topic;
  }

  function currentProbe(topicId: string): Probe | null {
    const placement = db.select().from(placements).where(eq(placements.topicId, topicId)).get();
    if (!placement) return null;
    const probes = placement.probes as Probe[];
    const points = loadPoints(db).filter((p) => p.topicId === topicId);
    const nextId = nextProbe(points, probes.map((p) => p.pointId), placement.answers as StoredAnswer[], placement.startIds as string[]);
    return probes.find((p) => p.pointId === nextId) ?? null;
  }

  /** 按摸底结果设定初始掌握状态；已经学过的知识点不受影响 */
  function finish(topicId: string, answers: StoredAnswer[], now: Date) {
    const points = loadPoints(db).filter((p) => p.topicId === topicId);
    const states = loadStates(db);
    const results = placementResults(points, answers);
    db.transaction((tx) => {
      for (const [pointId, result] of results) {
        if (states.get(pointId)?.stage !== 'unlearned') continue;
        saveState(tx, pointId, fromPlacement(result, now), now);
      }
      tx.update(placements).set({ finishedAt: now }).where(eq(placements.topicId, topicId)).run();
      tx.update(topics).set({ placementStatus: 'done' }).where(eq(topics.id, topicId)).run();
    });
    enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
  }

  function summarize(topicId: string, answers: StoredAnswer[]) {
    const points = loadPoints(db).filter((p) => p.topicId === topicId);
    const results = [...placementResults(points, answers).values()];
    return {
      correct: results.filter((r) => r === 'correct').length,
      inferred: results.filter((r) => r === 'inferred').length,
      unknown: results.filter((r) => r === 'unknown').length,
    };
  }

  return { begin, skip, status, answer };
}

export type Placement = ReturnType<typeof createPlacement>;
