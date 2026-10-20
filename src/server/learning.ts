import { randomUUID } from 'node:crypto';
import { type SQL, and, asc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import type { StructuredModel } from '../ai/gateway';
import { gradeShortAnswer } from '../ai/generators';
import { type PoolItem, assemble } from '../domain/assemble';
import { cognitiveEdge } from '../domain/edge';
import type { ExplainForm, QuestionForm } from '../domain/forms';
import { gradeMcq } from '../domain/grading';
import { type Outcome, type SelfRating, UNLEARNED, applyLessonOutcome, applyReviewOutcome, hasLearned, relearn } from '../domain/memory';
import type { PoolNeed } from '../domain/plan-pool';
import { settleWithLimit } from '../jobs/concurrency';
import { contextOf, generateItem } from '../jobs/generate-item';
import { enqueue } from '../jobs/queue';
import type { Settings } from '../settings';
import type { Grade, LessonContent, Question, ReviewContent } from '../shared/content';
import type { Db } from '../store/db';
import { createTopic, getItems, getTopic, insertItem, loadPoints, loadPool, loadStates, markItemsUsed, saveState } from '../store/repo';
import { attempts, items, jobs, knowledgePoints, sessionItems, sessions, topics } from '../store/schema';

export interface LearningDeps {
  db: Db;
  model: StructuredModel;
  settings: Settings;
}

/** 业务错误：由接口层转成 4xx */
export class LearningError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export type Answer = { choice: number } | { text: string };

type ItemRow = typeof items.$inferSelect;

/** 学习流程：新建主题、开始一节、作答、自评、结束。 */
export function createLearning({ db, model, settings }: LearningDeps) {
  function startTopic(title: string, now: Date) {
    const topicId = createTopic(db, title, now);
    enqueue(db, 'generate_graph', { topicId }, now);
    return { topicId };
  }

  function listTopics() {
    return db.select().from(topics).orderBy(asc(topics.createdAt)).all();
  }

  /**
   * 开始下一节：有未结束的就继续它；否则从候选池按组装规则挑选。
   * 没有补充说明时只读候选池、不调用 AI，即时返回。
   * 有补充说明时，先按组装规则挑好这一节的内容，再按补充说明逐项重新生成（形式不变）；
   * 某项生成失败就沿用候选池里的原内容，不让这一节因此开不了。
   */
  async function nextSession(now: Date, guidance?: string) {
    const open = findOpenSession();
    if (open) return { session: viewSession(open.id), preparing: false, resumed: true, guided: null };

    let picked = assemble({
      points: loadPoints(db),
      states: loadStates(db),
      pool: loadPool(db),
      now,
      budgetSeconds: settings.budgetSeconds,
      maxNewPerSession: settings.maxNewPerSession,
    }).items;
    if (picked.length === 0) return { session: null, preparing: hasPendingWork(), resumed: false, guided: null };

    let guided: { applied: number; total: number } | null = null;
    if (guidance) {
      const result = await regenerate(picked, guidance, now);
      picked = result.items;
      guided = { applied: result.applied, total: picked.length };
      // 生成要等一会儿；这期间如果已经开了别的一节（例如重复点击），以那一节为准
      const opened = findOpenSession();
      if (opened) return { session: viewSession(opened.id), preparing: false, resumed: true, guided: null };
    }

    const sessionId = randomUUID();
    db.transaction((tx) => {
      tx.insert(sessions).values({ id: sessionId, startedAt: now, budgetSeconds: settings.budgetSeconds }).run();
      picked.forEach((item, position) => tx.insert(sessionItems).values({ sessionId, itemId: item.id, position }).run());
      markItemsUsed(tx, picked.map((i) => i.id));
    });
    return { session: viewSession(sessionId), preparing: false, resumed: false, guided };
  }

  /** 提交作答：选择题按规则判分，简答由 AI 批改。答错时立即更新记忆状态；答对时等自评。 */
  async function submitAttempt(input: { sessionId: string; itemId: string; answer: Answer; durationMs?: number }, now: Date) {
    const item = requireSessionItem(input.sessionId, input.itemId);
    const exists = db
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.sessionId, input.sessionId), eq(attempts.itemId, input.itemId)))
      .get();
    if (exists) throw new LearningError('这一项已经作答过了', 409);

    const question = questionOf(item);
    const grade = await gradeAnswer(item, question, input.answer);
    const attemptId = randomUUID();
    db.insert(attempts)
      .values({
        id: attemptId,
        itemId: item.id,
        sessionId: input.sessionId,
        answer: input.answer,
        correct: grade.correct,
        errorType: grade.errorType,
        feedback: grade.feedback,
        durationMs: input.durationMs,
        createdAt: now,
      })
      .run();
    if (!grade.correct) applyOutcome(attemptId, item, { correct: false }, now);
    return { attemptId, ...grade, needsRating: grade.correct, reveal: reveal(question) };
  }

  /** 答对后的自评 */
  function rateAttempt(attemptId: string, selfRating: SelfRating, now: Date) {
    const attempt = db.select().from(attempts).where(eq(attempts.id, attemptId)).get();
    if (!attempt) throw new LearningError('作答记录不存在', 404);
    if (!attempt.correct) throw new LearningError('答错时不需要自评', 400);
    if (attempt.applied) throw new LearningError('这次作答已经自评过了', 409);
    const [item] = getItems(db, [attempt.itemId]);
    applyOutcome(attemptId, item!, { correct: true, selfRating }, now);
    return { ok: true };
  }

  /** 结束一节：答对但没自评的按"良好"处理，然后在后台补满候选池。 */
  function finishSession(sessionId: string, now: Date) {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session) throw new LearningError('这一节不存在', 404);
    if (session.finishedAt) return { ok: true };
    const unrated = db
      .select()
      .from(attempts)
      .where(and(eq(attempts.sessionId, sessionId), eq(attempts.applied, false)))
      .all();
    for (const attempt of unrated) {
      const [item] = getItems(db, [attempt.itemId]);
      applyOutcome(attempt.id, item!, { correct: true, selfRating: 'good' }, now);
    }
    db.update(sessions).set({ finishedAt: now }).where(eq(sessions.id, sessionId)).run();
    enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
    return { ok: true };
  }

  /**
   * 认知地图中某个主题的部分：每个知识点的掌握阶段、是否在认知边缘，以及学过的内容和作答记录。
   * 只给已经作答过的内容：还没学的知识点只显示标题和概要，讲解要在微课堂里配合小题学。
   */
  function topicMap(topicId: string) {
    const topic = getTopic(db, topicId);
    if (!topic) throw new LearningError('学习主题不存在', 404);
    const allPoints = loadPoints(db);
    const states = loadStates(db);
    const edgeIds = new Set(cognitiveEdge(allPoints, states).map((p) => p.id));
    const points = allPoints.filter((p) => p.topicId === topicId).sort((a, b) => a.position - b.position);

    const records = loadRecords(eq(knowledgePoints.topicId, topicId));

    return {
      topic,
      points: points.map((point) => {
        const state = states.get(point.id) ?? UNLEARNED;
        return {
          id: point.id,
          title: point.title,
          summary: point.summary,
          stage: state.stage,
          onEdge: edgeIds.has(point.id),
          nextReviewAt: state.card?.due ?? null,
          records: records
            .filter((r) => r.item.knowledgePointId === point.id)
            .map(toRecord),
        };
      }),
    };
  }

  /**
   * 按天回看：有学习记录的日子（按用户所在时区划分），最近的在前。
   * 指定主题时只算这个主题的知识点。
   */
  function reviewDays(input: { timeZone: string; topicId?: string }) {
    if (input.topicId && !getTopic(db, input.topicId)) throw new LearningError('学习主题不存在', 404);
    const dayOf = dayFormatter(input.timeZone);
    const rows = db
      .select({ at: attempts.createdAt, knowledgePointId: items.knowledgePointId })
      .from(attempts)
      .innerJoin(items, eq(attempts.itemId, items.id))
      .innerJoin(knowledgePoints, eq(items.knowledgePointId, knowledgePoints.id))
      .where(input.topicId ? eq(knowledgePoints.topicId, input.topicId) : undefined)
      .all();
    const pointsByDay = new Map<string, Set<string>>();
    for (const row of rows) {
      const day = dayOf(row.at);
      pointsByDay.set(day, (pointsByDay.get(day) ?? new Set()).add(row.knowledgePointId));
    }
    return [...pointsByDay]
      .map(([day, pointIds]) => ({ day, pointCount: pointIds.size }))
      .sort((a, b) => b.day.localeCompare(a.day));
  }

  /** 按天回看：那一天的全部作答留档（讲解、题目、回答、批改），按当时的先后顺序 */
  function dayReview(input: { day: string; timeZone: string; topicId?: string }) {
    const topic = input.topicId ? getTopic(db, input.topicId) : null;
    if (input.topicId && !topic) throw new LearningError('学习主题不存在', 404);
    const dayOf = dayFormatter(input.timeZone);
    // 先按 UTC 前后各放宽 14 小时（覆盖所有时区）粗筛，再按用户时区精确判断是不是这一天
    const dayStart = Date.parse(`${input.day}T00:00:00Z`);
    const range = and(
      gte(attempts.createdAt, new Date(dayStart - 14 * HOUR_MS)),
      lt(attempts.createdAt, new Date(dayStart + 38 * HOUR_MS)),
    );
    const rows = loadRecords(input.topicId ? and(range, eq(knowledgePoints.topicId, input.topicId)) : range).filter(
      (row) => dayOf(row.attempt.createdAt) === input.day,
    );
    const states = loadStates(db);
    return {
      day: input.day,
      topic: topic ?? null,
      entries: rows.map((row) => ({
        topicTitle: row.topicTitle,
        point: { id: row.point.id, title: row.point.title, stage: (states.get(row.point.id) ?? UNLEARNED).stage },
        record: toRecord(row),
      })),
    };
  }

  /**
   * 重新学习一批知识点：已学过的退回理解阶段，由下一节微课堂换一种讲法重讲。
   * 还没学会的（未学、理解阶段）本来就会被讲解，跳过。
   * 知识点还在未完成的一节里等作答或自评时拒绝，避免那一项作答后无法按原阶段更新。
   */
  function relearnPoints(knowledgePointIds: string[], now: Date) {
    const states = loadStates(db);
    const missing = knowledgePointIds.filter((id) => !states.has(id));
    if (missing.length > 0) throw new LearningError('知识点不存在', 404);
    const targets = knowledgePointIds.filter((id) => hasLearned(states.get(id)!.stage));

    const busy = pendingInOpenSession(targets);
    if (busy.length > 0) throw new LearningError('有知识点还在未完成的一节微课堂里，先完成那一节再重新学习', 409);

    db.transaction((tx) => {
      for (const id of targets) saveState(tx, id, relearn(states.get(id)!), now);
    });
    // 理解阶段需要一项新的讲解，后台补进候选池
    if (targets.length > 0) enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
    return { relearned: targets };
  }

  // ---------- 内部 ----------

  function findOpenSession() {
    return db.select().from(sessions).where(isNull(sessions.finishedAt)).orderBy(asc(sessions.startedAt)).get();
  }

  /** 按补充说明重新生成挑好的内容：成功的存入并替换原内容，失败的沿用原内容 */
  async function regenerate(picked: PoolItem[], guidance: string, now: Date) {
    const points = loadPoints(db);
    const byId = new Map(points.map((p) => [p.id, p]));
    const results = await settleWithLimit(
      picked.map((item) => () => generateItem(model, contextOf(byId.get(item.knowledgePointId)!, byId, guidance), needOf(item))),
      settings.generationConcurrency,
    );
    const replaced = picked.map((item, i): PoolItem => {
      const result = results[i]!;
      if (result.status === 'rejected') {
        console.warn(`按补充说明生成失败，沿用原内容（${item.kind} / ${item.knowledgePointId}）：${String(result.reason)}`);
        return item;
      }
      const id = db.transaction((tx) => {
        tx.update(items).set({ status: 'void' }).where(eq(items.id, item.id)).run();
        return insertItem(tx, result.value, now);
      });
      return { ...item, id, estSeconds: result.value.estSeconds };
    });
    return { items: replaced, applied: results.filter((r) => r.status === 'fulfilled').length };
  }

  /** 作答留档连同所属的内容、知识点和主题，按作答时间排序 */
  function loadRecords(filter: SQL | undefined) {
    return db
      .select({ attempt: attempts, item: items, point: knowledgePoints, topicTitle: topics.title })
      .from(attempts)
      .innerJoin(items, eq(attempts.itemId, items.id))
      .innerJoin(knowledgePoints, eq(items.knowledgePointId, knowledgePoints.id))
      .innerJoin(topics, eq(knowledgePoints.topicId, topics.id))
      .where(filter)
      .orderBy(asc(attempts.createdAt))
      .all();
  }

  /** 在未结束的一节里、还没按作答更新记忆状态的知识点 */
  function pendingInOpenSession(knowledgePointIds: string[]): string[] {
    if (knowledgePointIds.length === 0) return [];
    const rows = db
      .select({ knowledgePointId: items.knowledgePointId, applied: attempts.applied })
      .from(sessionItems)
      .innerJoin(sessions, eq(sessionItems.sessionId, sessions.id))
      .innerJoin(items, eq(sessionItems.itemId, items.id))
      .leftJoin(attempts, and(eq(attempts.sessionId, sessionItems.sessionId), eq(attempts.itemId, sessionItems.itemId)))
      .where(and(isNull(sessions.finishedAt), inArray(items.knowledgePointId, knowledgePointIds)))
      .all();
    return rows.filter((r) => !r.applied).map((r) => r.knowledgePointId);
  }

  function applyOutcome(attemptId: string, item: ItemRow, outcome: Outcome, now: Date) {
    const states = loadStates(db);
    const state = states.get(item.knowledgePointId) ?? UNLEARNED;
    const question = questionOf(item);
    const next =
      item.kind === 'lesson'
        ? applyLessonOutcome(state, { explainForm: item.form, questionForm: question.type }, outcome, now)
        : applyReviewOutcome(state, item.form, outcome, now);
    db.transaction((tx) => {
      saveState(tx, item.knowledgePointId, next, now);
      tx.update(attempts)
        .set({ applied: true, selfRating: outcome.correct ? outcome.selfRating : null })
        .where(eq(attempts.id, attemptId))
        .run();
    });
  }

  async function gradeAnswer(item: ItemRow, question: Question, answer: Answer): Promise<Grade> {
    if (question.type === 'mcq') {
      if (!('choice' in answer)) throw new LearningError('选择题需要提交选项序号', 400);
      return gradeMcq(question, answer.choice);
    }
    if (!('text' in answer)) throw new LearningError('简答题需要提交文字作答', 400);
    const point = loadPoints(db).find((p) => p.id === item.knowledgePointId);
    return gradeShortAnswer(model, { topicTitle: point?.topicTitle ?? '', title: point?.title ?? '' }, question, answer.text);
  }

  function requireSessionItem(sessionId: string, itemId: string): ItemRow {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session) throw new LearningError('这一节不存在', 404);
    if (session.finishedAt) throw new LearningError('这一节已经结束', 409);
    const link = db
      .select()
      .from(sessionItems)
      .where(and(eq(sessionItems.sessionId, sessionId), eq(sessionItems.itemId, itemId)))
      .get();
    if (!link) throw new LearningError('这一项不属于本节', 404);
    return getItems(db, [itemId])[0]!;
  }

  function hasPendingWork(): boolean {
    return db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.status, ['pending', 'running'])).get() !== undefined;
  }

  /** 给前端看的一节内容：作答前不包含答案。 */
  function viewSession(sessionId: string) {
    const links = db.select().from(sessionItems).where(eq(sessionItems.sessionId, sessionId)).orderBy(asc(sessionItems.position)).all();
    const rows = new Map(getItems(db, links.map((l) => l.itemId)).map((r) => [r.id, r]));
    const done = db.select().from(attempts).where(eq(attempts.sessionId, sessionId)).all();
    const titles = new Map(loadPoints(db).map((p) => [p.id, p.title]));
    // 之前的节里讲过的知识点，这次的讲解就是重讲
    const taughtBefore = new Set(
      db
        .select({ knowledgePointId: items.knowledgePointId, sessionId: attempts.sessionId })
        .from(attempts)
        .innerJoin(items, eq(attempts.itemId, items.id))
        .all()
        .filter((r) => r.sessionId !== sessionId)
        .map((r) => r.knowledgePointId),
    );
    return {
      id: sessionId,
      items: links.map((link) => {
        const row = rows.get(link.itemId)!;
        const attempt = done.find((a) => a.itemId === row.id);
        const question = questionOf(row);
        return {
          id: row.id,
          kind: row.kind,
          purpose: purposeOf(row, taughtBefore),
          form: row.form,
          knowledgePointId: row.knowledgePointId,
          title: titles.get(row.knowledgePointId) ?? '',
          estSeconds: row.estSeconds,
          explanation: row.kind === 'lesson' ? (row.content as LessonContent).explanation : null,
          question: hideAnswer(question),
          attempt: attempt
            ? {
                attemptId: attempt.id,
                correct: attempt.correct,
                errorType: attempt.errorType,
                feedback: attempt.feedback,
                needsRating: attempt.correct && !attempt.applied,
                reveal: reveal(question),
              }
            : null,
        };
      }),
    };
  }

  return { startTopic, listTopics, topicMap, reviewDays, dayReview, relearnPoints, nextSession, submitAttempt, rateAttempt, finishSession };
}

export type Learning = ReturnType<typeof createLearning>;

/** 这一项在本节中的用途：新学、重讲（之前讲过但没学会）或复习 */
export type ItemPurpose = 'new' | 'advance' | 'review';

function purposeOf(item: ItemRow, taughtBefore: Set<string>): ItemPurpose {
  if (item.kind === 'review') return 'review';
  return taughtBefore.has(item.knowledgePointId) ? 'advance' : 'new';
}

const HOUR_MS = 3600 * 1000;

/** 把时间换算成用户所在时区的日期（YYYY-MM-DD）；时区名不合法时报 400 */
function dayFormatter(timeZone: string): (date: Date) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    throw new LearningError(`不认识的时区：${timeZone}`, 400);
  }
  return (date) => format.format(date);
}

/** 一次作答的留档：作答过的题目连同答案一起给出 */
function toRecord({ attempt, item }: { attempt: typeof attempts.$inferSelect; item: ItemRow }) {
  return {
    attemptId: attempt.id,
    at: attempt.createdAt,
    kind: item.kind,
    explanation: item.kind === 'lesson' ? (item.content as LessonContent).explanation : null,
    question: questionOf(item),
    answer: attempt.answer as Answer,
    correct: attempt.correct,
    errorType: attempt.errorType,
    feedback: attempt.feedback,
    selfRating: attempt.selfRating,
  };
}

/** 候选池中一项内容的形式，换算成重新生成时需要的形式 */
function needOf(item: PoolItem): PoolNeed {
  // 形式都是本系统生成内容时写入的，取值必在 EXPLAIN_FORMS / QUESTION_FORMS 中
  return item.kind === 'lesson'
    ? { kind: 'lesson', knowledgePointId: item.knowledgePointId, explainForm: item.form as ExplainForm, questionForm: item.questionForm as QuestionForm }
    : { kind: 'review', knowledgePointId: item.knowledgePointId, questionForm: item.form as QuestionForm };
}

function questionOf(item: ItemRow): Question {
  return item.kind === 'lesson' ? (item.content as LessonContent).check : (item.content as ReviewContent).question;
}

function hideAnswer(question: Question) {
  return question.type === 'mcq'
    ? { type: question.type, stem: question.stem, options: question.options.map((o) => o.text) }
    : { type: question.type, prompt: question.prompt };
}

/** 作答后展示的参考答案 */
function reveal(question: Question) {
  return question.type === 'mcq'
    ? { answerIndex: question.answerIndex, explanation: question.explanation }
    : { referenceAnswer: question.referenceAnswer, keyPoints: question.keyPoints };
}
