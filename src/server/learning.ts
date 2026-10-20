import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { StructuredModel } from '../ai/gateway';
import { gradeShortAnswer } from '../ai/generators';
import { assemble } from '../domain/assemble';
import { cognitiveEdge } from '../domain/edge';
import { gradeMcq } from '../domain/grading';
import { type Outcome, type SelfRating, UNLEARNED, applyLessonOutcome, applyReviewOutcome, hasLearned, relearn } from '../domain/memory';
import { enqueue } from '../jobs/queue';
import type { Settings } from '../settings';
import type { Grade, LessonContent, Question, ReviewContent } from '../shared/content';
import type { Db } from '../store/db';
import { createTopic, getItems, getTopic, loadPoints, loadPool, loadStates, markItemsUsed, saveState } from '../store/repo';
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
   * 这里只读候选池，不调用 AI。
   */
  function nextSession(now: Date) {
    const open = db.select().from(sessions).where(isNull(sessions.finishedAt)).orderBy(asc(sessions.startedAt)).get();
    if (open) return { session: viewSession(open.id), preparing: false };

    const points = loadPoints(db);
    const { items: picked } = assemble({
      points,
      states: loadStates(db),
      pool: loadPool(db),
      now,
      budgetSeconds: settings.budgetSeconds,
      maxNewPerSession: settings.maxNewPerSession,
    });
    if (picked.length === 0) return { session: null, preparing: hasPendingWork() };

    const sessionId = randomUUID();
    db.transaction((tx) => {
      tx.insert(sessions).values({ id: sessionId, startedAt: now, budgetSeconds: settings.budgetSeconds }).run();
      picked.forEach((item, position) => tx.insert(sessionItems).values({ sessionId, itemId: item.id, position }).run());
      markItemsUsed(tx, picked.map((i) => i.id));
    });
    return { session: viewSession(sessionId), preparing: false };
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

    const records = db
      .select({ attempt: attempts, item: items })
      .from(attempts)
      .innerJoin(items, eq(attempts.itemId, items.id))
      .innerJoin(knowledgePoints, eq(items.knowledgePointId, knowledgePoints.id))
      .where(eq(knowledgePoints.topicId, topicId))
      .orderBy(asc(attempts.createdAt))
      .all();

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
            .map(({ attempt, item }) => ({
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
            })),
        };
      }),
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

  return { startTopic, listTopics, topicMap, relearnPoints, nextSession, submitAttempt, rateAttempt, finishSession };
}

export type Learning = ReturnType<typeof createLearning>;

/** 这一项在本节中的用途：新学、重讲（之前讲过但没学会）或复习 */
export type ItemPurpose = 'new' | 'advance' | 'review';

function purposeOf(item: ItemRow, taughtBefore: Set<string>): ItemPurpose {
  if (item.kind === 'review') return 'review';
  return taughtBefore.has(item.knowledgePointId) ? 'advance' : 'new';
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
