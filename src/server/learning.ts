import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import type { Illustrator, StructuredModel } from '../ai/gateway';
import { gradeConnection, gradeOpenAnswer, judgeAppeal } from '../ai/generators';
import { teachingContextLabel } from '../ai/teaching-context';
import { type PoolItem, assemble } from '../domain/assemble';
import { timeFactor } from '../domain/calibration';
import { type GraphPoint, cognitiveEdge, prerequisitesSatisfied } from '../domain/edge';
import { CONTRAST_FORM, type ExplainForm, type QuestionForm, isMobileForm } from '../domain/forms';
import { gradeMcq, gradePickLine, misconceptionOf } from '../domain/grading';
import {
  DECOMPOSE_FAIL_STREAK,
  type MemoryState,
  type Outcome,
  type SelfRating,
  UNLEARNED,
  applyLessonOutcome,
  applyReviewOutcome,
  hasLearned,
  hasSchedule,
  needsDecomposition,
} from '../domain/memory';
import type { PoolNeed } from '../domain/plan-pool';
import { ALL_SCOPE, type LearningScope, normalizeScope, sameScope, scopeIncludes } from '../domain/scope';
import { chooseNewTopic, revisitDue } from '../domain/topics';
import { fillPool } from '../jobs/fill-pool';
import { enqueue } from '../jobs/queue';
import { regenerateItems } from '../jobs/regenerate';
import { type Settings, readState, writeState } from '../settings';
import { isSubjectStyleId, type SubjectStyleId } from '../shared/subject-styles';
import { type ConnectionContent, type Grade, type Question, isOpenQuestion } from '../shared/content';
import { invalidateChangedTopics, teachingFingerprints } from '../teaching';
import type { Db } from '../store/db';
import {
  type PointInfo,
  createTopic,
  getItems,
  getTopic,
  insertItem,
  loadExistingKnowledge,
  loadPoints,
  loadPool,
  loadStates,
  markItemsUsed,
  saveState,
  wasDecomposed,
} from '../store/repo';
import { attempts, connections, courses, disciplines, items, jobs, knowledgePoints, memoryStates, sessionItems, sessions, topics } from '../store/schema';
import {
  type Answer,
  type Appeal,
  type ItemRow,
  LearningError,
  SERVER_TIME_ZONE,
  dayFormatter,
  formLabel,
  itemBody,
  questionOf,
  reveal,
  stateFromJson,
} from './views';

export { type Answer, LearningError } from './views';

export interface LearningDeps {
  db: Db;
  model: StructuredModel;
  /** 每次读取最新设置：设置页改动后立即生效 */
  settings: () => Settings;
  /** 按当前配置取画插画的模型；没有配置（或不传）时讲解只用代码画的图 */
  illustrator?: () => Illustrator | undefined;
}

/** 这一项在本节中的用途 */
export type ItemPurpose = (typeof sessionItems.$inferSelect)['purpose'];

export interface NextSessionOptions {
  /** 补充说明：按它重新生成本节内容 */
  guidance?: string;
  device?: 'desktop' | 'mobile';
  /** 用户所在时区，用于判断"今天"已学了几节 */
  timeZone?: string;
  /** 构建新一节：提前结束未完成的一节；候选池没有可学内容时当场生成 */
  fresh?: boolean;
  /** 明确继续未完成的一节（不新建、不改动） */
  resume?: boolean;
  /** 组装范围：全部、某个学科或某门课程 */
  scope?: LearningScope;
  /** 请求是否明确带了范围；明确带范围时对未完成课堂的处理更严格 */
  scopeProvided?: boolean;
  /** 兼容旧接口：只在指定学科标签内组装；scope 存在时不再使用 */
  subject?: string | null;
}

/**
 * 未完成的一节与请求的范围不一致（或请求没明确要继续）时抛出。
 * 响应里带上未完成的一节的快照，让前端明确选择"继续旧的"或"新建"，
 * 服务端不做任何破坏性操作。
 */
export class SessionConflictError extends LearningError {
  constructor(details: Record<string, unknown>) {
    super('还有未完成的一节微课堂，请选择继续它或构建新的一节', 409, 'open-session', details);
  }
}

/** 联结练习的预估时长（秒） */
const CONNECTION_SECONDS = 90;
const LAST_REVISIT_KEY = 'last_topic_revisit';

/** 学习流程：学习主题、开始一节、作答、自评、申诉、结束、主题回访。 */
export function createLearning({ db, model, settings: currentSettings, illustrator }: LearningDeps) {
  /** 当前配置了画图模型时，讲解可以配插画 */
  const illustrationsOn = () => illustrator?.() !== undefined;

  // ---------- 学习主题 ----------

  function startTopic(title: string, now: Date, courseId?: string | null) {
    if (courseId) requireCourse(courseId);
    const topicId = createTopic(db, title, now, undefined, undefined, courseId ?? null);
    enqueue(db, 'generate_graph', { topicId }, now);
    return { topicId };
  }

  function listTopics() {
    return db.select().from(topics).orderBy(asc(topics.createdAt)).all();
  }

  /**
   * 学科标签汇总（兼容旧接口）：每个标签下的主题数、有多少已能新学、有多少今天到期。
   * 内容风格现在由主题所属学科的预设决定，这里按该主题实际生效的预设给出。
   */
  function listSubjects() {
    const rows = loadPoints(db);
    const states = loadStates(db);
    const now = new Date();
    const bySubject = new Map<string, {
      subject: string;
      styleId: SubjectStyleId;
      group: string | null;
      ownStyle: boolean;
      topicIds: Set<string>;
      edge: number;
      due: number;
    }>();
    for (const topic of db.select().from(topics).where(isNotNull(topics.subject)).all()) {
      const subject = topic.subject!.trim();
      if (!subject) continue;
      const point = rows.find((p) => p.topicId === topic.id);
      const presetId: SubjectStyleId = point && isSubjectStyleId(point.presetId) ? point.presetId : 'default';
      const entry = bySubject.get(subject) ?? {
        subject,
        styleId: presetId,
        group: null,
        ownStyle: false,
        topicIds: new Set<string>(),
        edge: 0,
        due: 0,
      };
      entry.topicIds.add(topic.id);
      bySubject.set(subject, entry);
    }
    const edgeIds = new Set(cognitiveEdge(rows, states).map((p) => p.id));
    for (const p of rows) {
      const subject = p.topicSubject?.trim();
      const entry = subject ? bySubject.get(subject) : undefined;
      if (!entry) continue;
      if (edgeIds.has(p.id)) entry.edge += 1;
      const card = states.get(p.id)?.card;
      if (!p.excluded && card != null && card.due.getTime() <= now.getTime()) entry.due += 1;
    }
    return [...bySubject.values()]
      .map((e) => ({ subject: e.subject, styleId: e.styleId, group: e.group, ownStyle: e.ownStyle, topicCount: e.topicIds.size, edge: e.edge, due: e.due }))
      .sort((a, b) => a.subject.localeCompare(b.subject, 'zh-CN'));
  }

  /**
   * 暂停或恢复主题、调整优先级、改学科标签、改所属课程。
   * 暂停的主题不再新学，复习照常进行。
   *
   * 换课程会换内容风格：只有目标课程的预设与当前不同、且这个主题还有待学内容时，
   * 才需要先确认影响范围（confirmed）。这样直接 PATCH 不会在用户不知情时作废内容。
   */
  function updateTopic(
    topicId: string,
    patch: { status?: 'active' | 'paused'; priority?: number; subject?: string | null; courseId?: string | null; confirmed?: boolean },
    now: Date,
  ) {
    const topic = getTopic(db, topicId);
    if (!topic) throw new LearningError('学习主题不存在', 404);
    if (patch.courseId) requireCourse(patch.courseId);
    // 清空标签和从未设过标签是同一件事，统一存 null，避免出现空字符串这个独立标签
    const { confirmed, ...fields } = patch;
    const next: Partial<typeof topics.$inferInsert> = { ...fields };
    if ('subject' in fields) next.subject = fields.subject?.trim() || null;
    const courseChanged = 'courseId' in fields && (fields.courseId ?? null) !== (topic.courseId ?? null);
    if (courseChanged) next.courseId = fields.courseId ?? null;

    // 归属变了但预设相同（或还没有待学内容）时不用确认，也不必重新备课
    const presetOf = (courseId: string | null | undefined) =>
      courseId
        ? db.select({ presetId: disciplines.presetId }).from(courses)
            .innerJoin(disciplines, eq(courses.disciplineId, disciplines.id))
            .where(eq(courses.id, courseId)).get()?.presetId
        : null;
    const teachingChangedByMove = courseChanged && presetOf(fields.courseId) !== presetOf(topic.courseId);
    if (teachingChangedByMove && !confirmed) {
      const pooled = db
        .select({ id: items.id })
        .from(items)
        .innerJoin(knowledgePoints, eq(items.knowledgePointId, knowledgePoints.id))
        .where(and(eq(knowledgePoints.topicId, topicId), eq(items.status, 'pooled'), inArray(items.kind, ['lesson', 'review'])))
        .all();
      if (pooled.length > 0) {
        throw new LearningError('换到这门课程会作废这个主题的待学内容，请先确认影响范围', 409, 'teaching-impact', {
          affectedCourses: next.courseId ? 1 : 0,
          affectedTopics: 1,
          affectedItems: pooled.length,
          modelCalls: true,
          estimatedModelCalls: pooled.length,
        });
      }
    }

    return db.transaction((tx) => {
      const settings = currentSettings();
      const before = courseChanged ? teachingFingerprints(tx, settings) : null;
      tx.update(topics).set(next).where(eq(topics.id, topicId)).run();
      if (before) {
        // 归属变了可能换了内容风格：只作废真正受影响主题里尚未使用的内容
        const changed = invalidateChangedTopics(tx, before, teachingFingerprints(tx, currentSettings()));
        if (changed.length > 0) enqueue(tx, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
      }
      // 恢复的主题需要备新学内容
      if (patch.status === 'active' && topic.status === 'paused') {
        enqueue(tx, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
      }
      return tx.select().from(topics).where(eq(topics.id, topicId)).get()!;
    });
  }

  // ---------- 开始一节 ----------

  /**
   * 开始下一节。未完成课堂的处理规则：
   * - 明确 resume=true：继续未完成的那一节，不论范围（不改动任何数据）；
   * - 请求带了范围且与未完成的一节不同：返回 409 与两边快照，不做任何破坏性操作；
   * - 请求带了范围、与未完成的一节相同：也返回 409，让用户明确选择继续还是新建——
   *   只有明确 fresh=true 才新建，且旧的未完成课堂在新的一节真正建好后才会结束。
   *
   * 没有未完成的一节时，从候选池按组装规则挑好内容即时返回（不调用 AI）。
   * 带补充说明时先挑好本节内容，再按补充说明逐项重新生成（形式不变）；失败时沿用原内容。
   * fresh 为构建新一节：候选池没有可学内容时当场生成；新的一节生成失败时旧课堂仍可恢复。
   */
  async function nextSession(now: Date, options: NextSessionOptions = {}) {
    const empty = { session: null, preparing: false, resumed: false, guided: null, capped: false };
    const scope = normalizeScope(options.scope);
    const open = findOpenSession();
    if (open && options.resume) return { ...empty, session: viewSession(open.id), resumed: true };
    // 明确带了范围的请求（界面总是带）必须自己选：继续旧的，或确认新建。
    // 直接调用本服务时可能只有 scope 而没有 scopeProvided，同样按"明确带了范围"处理，
    // 否则会静默继续范围不同的旧课堂。两者都没有的旧调用方沿用原来的"继续未完成的一节"。
    const strict = options.scopeProvided === true || options.scope !== undefined;
    if (open && !options.fresh && !strict) return { ...empty, session: viewSession(open.id), resumed: true };
    if (open && !options.fresh) {
      throw new SessionConflictError({ openSession: openSessionSummary(open), requestedScope: { ...scope, label: scopeDescription(scope).label } });
    }

    const settings = currentSettings();
    if (settings.dailySessionCap !== null && finishedToday(now, options.timeZone) >= settings.dailySessionCap) {
      return { ...empty, capped: true };
    }

    const mobile = options.device === 'mobile';
    const subject = options.subject ?? null;
    const assembled = await buildSession(now, { mobile, settings, scope, subject, fresh: options.fresh, guidance: options.guidance });
    if (!assembled) {
      // 新的一节没建成：旧的未完成课堂保持原样，仍可恢复
      return { ...empty, preparing: hasPendingWork() };
    }
    // 新的一节已经建好，此时才结束旧的未完成课堂
    if (open) finishSession(open.id, now);
    return { ...empty, session: viewSession(assembled.sessionId), guided: assembled.guided };
  }

  /**
   * 按范围从候选池组装一节并写入；没有可学内容时返回 null（不结束任何已有的课堂）。
   * 从挑内容到写入之间不再调用模型，除非用户明确要求 fresh 或带补充说明。
   */
  async function buildSession(
    now: Date,
    options: {
      mobile: boolean;
      settings: Settings;
      scope: LearningScope;
      subject: string | null;
      fresh?: boolean;
      guidance?: string;
    },
  ): Promise<{ sessionId: string; guided: { applied: number; total: number } | null } | null> {
    const { mobile, settings, scope, subject } = options;
    let points = loadPoints(db);
    let states = loadStates(db);
    let picked = pickFromPool(now, points, states, mobile, settings, scope, subject).items;
    if (picked.length === 0 && options.fresh) {
      await fillPool({ db, model, settings: currentSettings, clock: () => now, illustrations: illustrationsOn() }, now);
      picked = pickFromPool(now, loadPoints(db), loadStates(db), mobile, settings, scope, subject).items;
    }
    if (picked.length === 0) return null;

    let guided: { applied: number; total: number } | null = null;
    if (options.guidance) {
      const result = await regenerate(picked, options.guidance, now);
      picked = result.items;
      guided = { applied: result.applied, total: picked.length };
    }

    // 生成期间可能在地图里改了学习选择或改了范围，按此刻的状态创建课堂
    points = loadPoints(db);
    states = loadStates(db);
    const stageOf = (id: string) => (states.get(id) ?? UNLEARNED).stage;
    const edgeIds = new Set(cognitiveEdge(points, states).map((p) => p.id));
    const excludedIds = new Set(points.filter((p) => p.excluded).map((p) => p.id));
    const inScope = (p: PointInfo) => (subject !== null ? p.subject === subject : scopeIncludes(scope, p));
    const includedIds = new Set(points.filter((p) => {
      if (p.excluded) return false;
      if (!inScope(p)) return false;
      if (stageOf(p.id) === 'unlearned') return edgeIds.has(p.id);
      if (stageOf(p.id) === 'understand') return prerequisitesSatisfied(p, stageOf, excludedIds);
      return true;
    }).map((p) => p.id));
    picked = picked.filter((item) => includedIds.has(item.knowledgePointId));
    if (picked.length === 0) return null;
    const byId = new Map(points.map((p) => [p.id, p]));
    const entries = withConnections(
      picked.map((item) => ({ itemId: item.id, purpose: purposeOf(item, states.get(item.knowledgePointId) ?? UNLEARNED) })),
      picked,
      byId,
      states,
      now,
    );
    const firstNew = entries.find((e) => e.purpose === 'new');
    const newTopicId = firstNew ? (byId.get(picked.find((i) => i.id === firstNew.itemId)!.knowledgePointId)?.topicId ?? null) : null;
    const snapshot = scopeSnapshot(scope);

    const sessionId = randomUUID();
    db.transaction((tx) => {
      tx.insert(sessions)
        .values({
          id: sessionId,
          startedAt: now,
          budgetSeconds: settings.budgetSeconds,
          newTopicId,
          device: mobile ? 'mobile' : 'desktop',
          guidance: options.guidance ?? null,
          scopeKind: snapshot.kind,
          scopeId: snapshot.id,
          scopeLabel: snapshot.label,
        })
        .run();
      entries.forEach((entry, position) => tx.insert(sessionItems).values({ sessionId, itemId: entry.itemId, position, purpose: entry.purpose }).run());
      markItemsUsed(tx, picked.map((i) => i.id));
    });
    return { sessionId, guided };
  }

  /**
   * 预览下一节：不开始、不改动任何数据，只说明此刻打开会学什么、大约多久。
   * 首页据此回答"下一节准备好了吗"。
   *
   * 未完成的一节独立显示，带它开始时的范围快照（标签仍用那时的名字）；
   * items / dueCount 等字段始终反映当前请求的范围，两者互不替代。
   */
  function previewNext(
    now: Date,
    options: Pick<NextSessionOptions, 'device' | 'timeZone' | 'subject'> & { scope?: LearningScope } = {},
  ) {
    const settings = currentSettings();
    const open = findOpenSession();
    const sessionsToday = finishedToday(now, options.timeZone);
    const capped = !open && settings.dailySessionCap !== null && sessionsToday >= settings.dailySessionCap;
    const points = loadPoints(db);
    const states = loadStates(db);
    const scope = normalizeScope(options.scope);
    const subject = options.subject ?? null;
    const { items: picked, newPaused, timeFactor: factor } = pickFromPool(now, points, states, options.device === 'mobile', settings, scope, subject);
    const byId = new Map(points.map((p) => [p.id, p]));
    const purposes = picked.map((item) => purposeOf(item, states.get(item.knowledgePointId) ?? UNLEARNED));
    const count = (purpose: ItemPurpose) => purposes.filter((p) => p === purpose).length;
    const isDue = (p: PointInfo) => {
      const state = states.get(p.id) ?? UNLEARNED;
      const card = state.card;
      return !p.excluded && card != null && hasSchedule(state.stage) && card.due.getTime() <= now.getTime();
    };
    const inScope = (p: PointInfo) => (subject !== null ? p.subject === subject : scopeIncludes(scope, p));
    // 范围内到期的复习；scope 外的到期复习单独计数，提醒用户还有别处的内容在等
    const dueCount = points.filter((p) => inScope(p) && isDue(p)).length;
    const outsideDueCount = scope.kind === 'all' && subject === null ? 0 : points.filter((p) => !inScope(p) && isDue(p)).length;
    const openView = open ? viewSession(open.id) : null;
    return {
      scope: scopeDescription(scope),
      open: open && openView
        ? {
            id: openView.id,
            startedAt: openView.startedAt,
            // 开始时的范围快照：之后改名不影响已经开始的这一节
            scope: {
              kind: open.scopeKind,
              id: open.scopeId,
              label: open.scopeLabel ?? scopeDescription({ kind: open.scopeKind, id: open.scopeId ?? undefined }).label,
            },
            items: openView.items.map((item) => ({
              title: item.title,
              topicTitle: item.topicTitle,
              purpose: item.purpose,
              formLabel: item.formLabel,
              excluded: item.excluded,
              done: item.excluded || (item.attempt !== null && !item.attempt.needsRating),
            })),
          }
        : null,
      capped,
      sessionsToday,
      dailySessionCap: settings.dailySessionCap,
      preparing: picked.length === 0 && hasPendingWork(),
      newPaused,
      dueCount,
      outsideDueCount,
      counts: { review: count('review'), contrast: count('contrast'), spotCheck: count('spot_check'), advance: count('advance'), new: count('new') },
      estMinutes: Math.max(1, Math.round(picked.reduce((sum, item) => sum + item.estSeconds * factor, 0) / 60)),
      budgetMinutes: Math.round(settings.budgetSeconds / 60),
      items: picked.map((item, i) => ({
        title: byId.get(item.knowledgePointId)?.title ?? '',
        topicTitle: byId.get(item.knowledgePointId)?.topicTitle ?? '',
        purpose: purposes[i]!,
        formLabel: formLabel(item.form),
      })),
    };
  }

  // ---------- 作答 ----------

  /**
   * 提交作答：选择题、点选错误行按规则判分，简答、补全、修正和联结练习由 AI 批改。
   * 答错时立即更新记忆状态；答对时等自评。联结练习不计入记忆状态。
   */
  async function submitAttempt(input: { sessionId: string; itemId: string; answer: Answer; durationMs?: number }, now: Date) {
    const item = requireSessionItem(input.sessionId, input.itemId);
    const exists = db
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.sessionId, input.sessionId), eq(attempts.itemId, input.itemId)))
      .get();
    if (exists) throw new LearningError('这一项已经作答过了', 409);

    if (item.kind === 'connection') return submitConnection(item, input, now);

    const question = questionOf(item)!;
    const grade = await gradeAnswer(item, question, input.answer);
    // AI 批改期间可能改为不学或结束课堂，保存作答前再次确认
    requireSessionItem(input.sessionId, input.itemId);
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
    if (!grade.correct) {
      const misconception = question.type === 'mcq' && 'choice' in input.answer ? misconceptionOf(question, input.answer.choice) : grade.errorType === 'misconception' ? grade.feedback : null;
      applyOutcome(attemptId, item, { correct: false, errorType: grade.errorType ?? undefined, misconception }, now);
    }
    return { attemptId, ...grade, needsRating: grade.correct, reveal: reveal(question) };
  }

  /** 联结练习：认可时在认知地图上加一条带原话的联结；不认可时不入图，对方知识点立即到期复习 */
  async function submitConnection(item: ItemRow, input: { sessionId: string; answer: Answer; durationMs?: number }, now: Date) {
    if (!('text' in input.answer)) throw new LearningError('联结练习需要提交文字作答', 400);
    const content = item.content as ConnectionContent;
    const points = loadPoints(db);
    const point = points.find((p) => p.id === item.knowledgePointId);
    const verdict = await gradeConnection(
      model,
      { topicTitle: point?.topicTitle ?? '', title: point?.title ?? '', summary: point?.summary ?? '', partner: content.partner.title },
      content.prompt,
      input.answer.text,
      teachingContextLabel(point?.presetId),
    );
    requireSessionItem(input.sessionId, item.id);
    const attemptId = randomUUID();
    db.transaction((tx) => {
      tx.insert(attempts)
        .values({
          id: attemptId,
          itemId: item.id,
          sessionId: input.sessionId,
          answer: input.answer,
          correct: verdict.accepted,
          feedback: verdict.feedback,
          applied: true,
          durationMs: input.durationMs,
          createdAt: now,
        })
        .run();
      if (verdict.accepted) {
        tx.insert(connections)
          .values({
            id: randomUUID(),
            fromPointId: item.knowledgePointId,
            toPointId: content.partner.kind === 'point' ? content.partner.id : null,
            toExistingId: content.partner.kind === 'existing' ? content.partner.id : null,
            quote: (input.answer as { text: string }).text,
            relation: verdict.relation,
            attemptId,
            createdAt: now,
          })
          .run();
      }
    });
    if (!verdict.accepted && content.partner.kind === 'point') duePartnerNow(content.partner.id, now);
    return {
      attemptId,
      correct: verdict.accepted,
      errorType: null,
      feedback: verdict.feedback,
      needsRating: false,
      reveal: { relation: verdict.relation },
    };
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

  /**
   * 申诉：对判错的作答发起，由 AI 重新判定。
   * - 答案也成立：还原作答前的记忆状态，改判为答对，等用户补一次自评；
   * - 题目或参考答案有误：还原作答前的记忆状态，这次作答作废，不计入记忆状态；
   * - 维持原判：不变。
   * 只能对这个知识点最近一次计入记忆的作答申诉，否则还原会覆盖之后的进展。
   */
  async function appealAttempt(attemptId: string, reason: string, now: Date) {
    const attempt = db.select().from(attempts).where(eq(attempts.id, attemptId)).get();
    if (!attempt) throw new LearningError('作答记录不存在', 404);
    const [item] = getItems(db, [attempt.itemId]);
    if (!item || item.kind === 'connection') throw new LearningError('联结练习不能申诉', 400);
    if (attempt.correct) throw new LearningError('只能对判错的作答申诉', 400);
    if (attempt.appeal) throw new LearningError('这次作答已经申诉过了', 409);
    if (hasLaterApplied(attempt, item.knowledgePointId)) {
      throw new LearningError('这个知识点之后又有了新的作答，不能再对这一次申诉', 409);
    }

    const point = loadPoints(db).find((p) => p.id === item.knowledgePointId);
    const answer = attempt.answer as Answer;
    const verdict = await judgeAppeal(model, { topicTitle: point?.topicTitle ?? '', title: point?.title ?? '' }, {
      question: questionOf(item)!,
      answer: 'text' in answer ? answer.text : `选择了第 ${answer.choice + 1} 项`,
      originalFeedback: attempt.feedback ?? '',
      reason,
    }, teachingContextLabel(point?.presetId));
    const appeal: Appeal = { reason, outcome: verdict.outcome, feedback: verdict.feedback, at: now.toISOString() };
    const before = stateFromJson(attempt.stateBefore);

    db.transaction((tx) => {
      if (verdict.outcome !== 'rejected' && before) saveState(tx, item.knowledgePointId, before, now);
      if (verdict.outcome === 'accepted') {
        tx.update(attempts).set({ appeal, correct: true, errorType: null, applied: false }).where(eq(attempts.id, attemptId)).run();
      } else if (verdict.outcome === 'void') {
        tx.update(attempts).set({ appeal, voided: true }).where(eq(attempts.id, attemptId)).run();
        tx.update(items).set({ status: 'void' }).where(eq(items.id, item.id)).run();
      } else {
        tx.update(attempts).set({ appeal }).where(eq(attempts.id, attemptId)).run();
      }
    });
    if (verdict.outcome !== 'rejected') enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
    return { outcome: verdict.outcome, feedback: verdict.feedback, needsRating: verdict.outcome === 'accepted' };
  }

  // ---------- 结束一节 ----------

  /** 结束一节：答对但没自评的按"良好"处理，然后在后台补满候选池；到了主题回访的时候带上回访题。 */
  function finishSession(sessionId: string, now: Date) {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session) throw new LearningError('这一节不存在', 404);
    if (!session.finishedAt) {
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
    }
    return { ok: true, revisit: revisitQuestion(now) };
  }

  /** 主题回访题：问用户暂停的主题里哪些想恢复学习 */
  function revisitQuestion(now: Date) {
    const paused = db.select({ id: topics.id, title: topics.title }).from(topics).where(eq(topics.status, 'paused')).all();
    const last = readState<string>(db, LAST_REVISIT_KEY);
    const due = revisitDue(last ? new Date(last) : null, now, currentSettings().revisitIntervalDays, paused.length);
    return due ? { topics: paused } : null;
  }

  /** 回答主题回访：选中的主题恢复新学；"暂时都不"时传空数组。不计入记忆评分。 */
  function answerRevisit(resumeTopicIds: string[], now: Date) {
    db.transaction((tx) => {
      if (resumeTopicIds.length > 0) {
        tx.update(topics).set({ status: 'active' }).where(and(inArray(topics.id, resumeTopicIds), eq(topics.status, 'paused'))).run();
      }
      writeState(tx, LAST_REVISIT_KEY, now.toISOString(), now);
    });
    if (resumeTopicIds.length > 0) enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
    return { ok: true };
  }

  // ---------- 内部 ----------

  function findOpenSession() {
    return db.select().from(sessions).where(isNull(sessions.finishedAt)).orderBy(asc(sessions.startedAt)).get();
  }

  /** 未完成课堂的快照：用于 409 响应，让前端明确选择继续还是新建 */
  function openSessionSummary(session: typeof sessions.$inferSelect) {
    const view = viewSession(session.id);
    const scope: LearningScope = session.scopeKind === 'all'
      ? { kind: 'all' }
      : { kind: session.scopeKind, id: session.scopeId ?? undefined };
    return {
      id: session.id,
      startedAt: session.startedAt,
      scope: { ...scope, label: session.scopeLabel ?? scopeDescription(scope).label },
      items: view.items.map((item) => ({
        title: item.title,
        topicTitle: item.topicTitle,
        purpose: item.purpose,
        formLabel: item.formLabel,
        excluded: item.excluded,
        done: item.excluded || (item.attempt !== null && !item.attempt.needsRating),
      })),
    };
  }

  /** 范围的名字快照：开始一节时写入，之后改名不影响已经开始的这一节 */
  function scopeSnapshot(scope: LearningScope): { kind: LearningScope['kind']; id: string | null; label: string | null } {
    const description = scopeDescription(scope);
    return { kind: scope.kind, id: scope.kind === 'all' ? null : (scope.id ?? null), label: description.label };
  }

  /** 范围的可读描述：界面与快照共用 */
  function scopeDescription(scope: LearningScope): { kind: LearningScope['kind']; id: string | null; label: string } {
    if (scope.kind === 'discipline' && scope.id) {
      const row = db.select({ name: disciplines.name }).from(disciplines).where(eq(disciplines.id, scope.id)).get();
      return { kind: scope.kind, id: scope.id, label: row?.name ?? '已删除的学科' };
    }
    if (scope.kind === 'course' && scope.id) {
      const row = db.select({ name: courses.name, disciplineName: disciplines.name })
        .from(courses)
        .leftJoin(disciplines, eq(courses.disciplineId, disciplines.id))
        .where(eq(courses.id, scope.id))
        .get();
      return { kind: scope.kind, id: scope.id, label: row?.name ?? '已删除的课程' };
    }
    return { kind: 'all', id: null, label: '不限范围' };
  }

  /** 引用某门课程的主题必须指向存在的课程 */
  function requireCourse(courseId: string): void {
    if (!db.select({ id: courses.id }).from(courses).where(eq(courses.id, courseId)).get()) {
      throw new LearningError('课程不存在', 404);
    }
  }

  /** 今天（用户时区）已经完成了几节 */
  function finishedToday(now: Date, timeZone = SERVER_TIME_ZONE): number {
    const dayOf = dayFormatter(timeZone);
    const today = dayOf(now);
    return db
      .select({ finishedAt: sessions.finishedAt })
      .from(sessions)
      .where(isNotNull(sessions.finishedAt))
      .all()
      .filter((s) => dayOf(s.finishedAt!) === today).length;
  }

  /** 按组装规则从候选池挑出一节（不写入数据库） */
  function pickFromPool(
    now: Date,
    points: PointInfo[],
    states: Map<string, MemoryState>,
    mobile: boolean,
    settings: Settings,
    scope: LearningScope = ALL_SCOPE,
    subject: string | null = null,
  ) {
    const pool = loadPool(db);
    const factor = currentTimeFactor();
    const result = assemble({
      points,
      states,
      pool,
      now,
      budgetSeconds: settings.budgetSeconds,
      maxNewPerSession: settings.maxNewPerSession,
      newTopicId: chooseTopicForNew(points, states, pool, mobile, scope, subject),
      scope,
      // 旧接口按标签限定范围时仍按标签过滤；新接口按 scope
      subject,
      mobile,
      timeFactor: factor,
    });
    return { ...result, timeFactor: factor };
  }

  /** 这一节的新知识点来自哪个主题：在候选池里备有新学内容的主题之间，按优先级轮换 */
  function chooseTopicForNew(
    points: PointInfo[],
    states: Map<string, MemoryState>,
    pool: PoolItem[],
    mobile: boolean,
    scope: LearningScope = ALL_SCOPE,
    subject: string | null = null,
  ): string | null {
    const ready = new Set(
      pool.filter((i) => i.kind === 'lesson' && (!mobile || isMobileForm(i.questionForm))).map((i) => i.knowledgePointId),
    );
    const inScope = (p: GraphPoint) => (subject !== null ? p.subject === subject : scopeIncludes(scope, p));
    const edge = cognitiveEdge(points, states).filter(inScope);
    const topicIds = new Set(edge.filter((p) => ready.has(p.id)).map((p) => p.topicId!));
    if (topicIds.size === 0) return null;
    const served = db.select({ newTopicId: sessions.newTopicId }).from(sessions).where(isNotNull(sessions.newTopicId)).all();
    const rows = db.select().from(topics).where(inArray(topics.id, [...topicIds])).all();
    return chooseNewTopic(
      rows.map((t) => ({
        topicId: t.id,
        priority: t.priority,
        servedSessions: served.filter((s) => s.newTopicId === t.id).length,
        createdAt: t.createdAt.getTime(),
      })),
    );
  }

  /** 时长校准系数：按最近的作答用时 */
  function currentTimeFactor(): number {
    const samples = db
      .select({ estSeconds: items.estSeconds, durationMs: attempts.durationMs })
      .from(attempts)
      .innerJoin(items, eq(attempts.itemId, items.id))
      .where(and(isNotNull(attempts.durationMs), ne(items.kind, 'connection')))
      .orderBy(desc(attempts.createdAt))
      .limit(20)
      .all()
      .reverse();
    return timeFactor(samples.map((s) => ({ estSeconds: s.estSeconds, durationMs: s.durationMs! })));
  }

  /** 每个新知识点之后插入一道联结练习：与已学会的前置、易混知识点，或用户的已有知识建立联系 */
  function withConnections(
    entries: { itemId: string; purpose: ItemPurpose }[],
    picked: PoolItem[],
    byId: Map<string, PointInfo>,
    states: Map<string, MemoryState>,
    now: Date,
  ) {
    const known = loadExistingKnowledge(db);
    const result: { itemId: string; purpose: ItemPurpose }[] = [];
    entries.forEach((entry, i) => {
      result.push(entry);
      if (entry.purpose !== 'new') return;
      const point = byId.get(picked[i]!.knowledgePointId);
      if (!point) return;
      const partner = choosePartner(point, byId, states, known);
      if (!partner) return;
      const content: ConnectionContent = { prompt: connectionPrompt(point.title, partner), partner };
      const itemId = insertItem(
        db,
        { knowledgePointId: point.id, kind: 'connection', form: 'connection', questionForm: 'connection', estSeconds: CONNECTION_SECONDS, content, status: 'used' },
        now,
      );
      result.push({ itemId, purpose: 'connection' });
    });
    return result;
  }

  /**
   * 按补充说明重新生成挑好的内容：成功的存入并替换原内容，失败的沿用原内容。
   * 生成与指纹核对都由 jobs/regenerate 统一完成：引导词与指纹按主题所属学科解析，
   * 生成期间配置变了就提示重试，过期内容不写入。
   */
  async function regenerate(picked: PoolItem[], guidance: string, now: Date) {
    const settings = currentSettings();
    const result = await regenerateItems(
      { db, model, settings: currentSettings, illustrations: illustrationsOn(), clock: () => now },
      picked.map((item) => ({ ...item })),
      guidance,
      now,
    );
    if (result.stale) {
      throw new LearningError('生成期间引导词已更新，请重新开始，新内容将按最新要求准备。', 409);
    }
    void settings;
    return { items: result.items, applied: result.applied };
  }

  /**
   * 按作答结果更新记忆状态，并记下更新前的状态（申诉改判时还原）。
   * 讲解类内容对已学过的知识点是对比讲解，按复习结果更新。
   * 理解或回忆阶段连续答错达到阈值时，后台拆解出更基础的前置知识点。
   */
  function applyOutcome(attemptId: string, item: ItemRow, outcome: Outcome, now: Date) {
    const state = loadStates(db).get(item.knowledgePointId) ?? UNLEARNED;
    const question = questionOf(item)!;
    let next: MemoryState;
    if (item.kind === 'lesson' && !hasSchedule(state.stage) && state.stage !== 'inferred') {
      next = applyLessonOutcome(state, { explainForm: item.form, questionForm: question.type }, outcome, now);
    } else if (hasSchedule(state.stage) || state.stage === 'inferred') {
      next = { ...applyReviewOutcome(state, question.type, outcome, now), lastExplainForm: item.kind === 'lesson' ? item.form : state.lastExplainForm };
    } else {
      // 知识点已被重新学习等操作改变了阶段，这次作答不再计入
      next = state;
    }
    db.transaction((tx) => {
      saveState(tx, item.knowledgePointId, next, now);
      tx.update(attempts)
        .set({ applied: true, selfRating: outcome.correct ? outcome.selfRating : null, stateBefore: state })
        .where(eq(attempts.id, attemptId))
        .run();
    });
    if (needsDecomposition(next) && next.failStreak === DECOMPOSE_FAIL_STREAK && !wasDecomposed(db, item.knowledgePointId)) {
      enqueue(db, 'decompose', { knowledgePointId: item.knowledgePointId }, now);
    }
  }

  async function gradeAnswer(item: ItemRow, question: Question, answer: Answer): Promise<Grade> {
    if (question.type === 'mcq' || question.type === 'pick_line') {
      if (!('choice' in answer)) throw new LearningError('这道题需要提交选项序号', 400);
      return question.type === 'mcq' ? gradeMcq(question, answer.choice) : gradePickLine(question, answer.choice);
    }
    if (!('text' in answer)) throw new LearningError('这道题需要提交文字作答', 400);
    if (!isOpenQuestion(question)) throw new LearningError('不支持的题目形式', 400);
    const point = loadPoints(db).find((p) => p.id === item.knowledgePointId);
    return gradeOpenAnswer(
      model,
      { topicTitle: point?.topicTitle ?? '', title: point?.title ?? '' },
      question,
      answer.text,
      teachingContextLabel(point?.presetId),
    );
  }

  /** 联结不成立：对方知识点立即到期，下一节复习它 */
  function duePartnerNow(pointId: string, now: Date) {
    if (db.select().from(memoryStates).where(eq(memoryStates.knowledgePointId, pointId)).get()?.excluded) return;
    const state = loadStates(db).get(pointId);
    if (!state?.card || !hasSchedule(state.stage)) return;
    saveState(db, pointId, { ...state, card: { ...state.card, due: now } }, now);
  }

  /** 这次作答之后（含同一时刻），同一知识点是否又有计入记忆的作答 */
  function hasLaterApplied(attempt: typeof attempts.$inferSelect, knowledgePointId: string): boolean {
    return db
      .select({ id: attempts.id, createdAt: attempts.createdAt })
      .from(attempts)
      .innerJoin(items, eq(attempts.itemId, items.id))
      .where(and(eq(items.knowledgePointId, knowledgePointId), eq(attempts.applied, true), ne(attempts.id, attempt.id), ne(items.kind, 'connection')))
      .all()
      .some((a) => a.createdAt.getTime() >= attempt.createdAt.getTime());
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
    const item = getItems(db, [itemId])[0]!;
    const state = db.select().from(memoryStates).where(eq(memoryStates.knowledgePointId, item.knowledgePointId)).get();
    if (state?.excluded) throw new LearningError('这个知识点已设为不学，重新加入学习后才能作答', 409);
    return item;
  }

  function hasPendingWork(): boolean {
    return db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.status, ['pending', 'running'])).get() !== undefined;
  }

  /** 给前端看的一节内容：作答前不包含答案。 */
  function viewSession(sessionId: string) {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;
    const links = db.select().from(sessionItems).where(eq(sessionItems.sessionId, sessionId)).orderBy(asc(sessionItems.position)).all();
    const rows = new Map(getItems(db, links.map((l) => l.itemId)).map((r) => [r.id, r]));
    const done = db.select().from(attempts).where(eq(attempts.sessionId, sessionId)).all();
    const points = new Map(loadPoints(db).map((p) => [p.id, p]));
    return {
      id: sessionId,
      startedAt: session.startedAt,
      budgetSeconds: session.budgetSeconds,
      guidance: session.guidance,
      items: links.map((link) => {
        const row = rows.get(link.itemId)!;
        const attempt = done.find((a) => a.itemId === row.id);
        const question = questionOf(row);
        const point = points.get(row.knowledgePointId);
        return {
          id: row.id,
          kind: row.kind,
          purpose: link.purpose,
          form: row.form,
          formLabel: formLabel(row.form),
          knowledgePointId: row.knowledgePointId,
          excluded: point?.excluded ?? false,
          title: point?.title ?? '',
          topicTitle: point?.topicTitle ?? '',
          estSeconds: row.estSeconds,
          ...itemBody(row),
          attempt: attempt
            ? {
                attemptId: attempt.id,
                correct: attempt.correct,
                errorType: attempt.errorType,
                feedback: attempt.feedback,
                needsRating: attempt.correct && !attempt.applied,
                reveal: question ? reveal(question) : null,
                appeal: (attempt.appeal as Appeal | null) ?? null,
                voided: attempt.voided,
              }
            : null,
        };
      }),
    };
  }

  return {
    startTopic,
    listTopics,
    listSubjects,
    updateTopic,
    nextSession,
    previewNext,
    submitAttempt,
    rateAttempt,
    appealAttempt,
    finishSession,
    answerRevisit,
  };
}

export type Learning = ReturnType<typeof createLearning>;
/** 组装时确定这一项的用途 */
function purposeOf(item: PoolItem, state: MemoryState): ItemPurpose {
  if (item.form === CONTRAST_FORM) return 'contrast';
  if (item.kind === 'review') return state.stage === 'inferred' ? 'spot_check' : 'review';
  return state.stage === 'unlearned' ? 'new' : 'advance';
}

/**
 * 联结练习的对象：已学会的前置知识点优先，其次已学会的易混知识点，再次用户的已有知识（同主题的优先）。
 * 都没有时不出联结练习。
 */
function choosePartner(
  point: PointInfo,
  byId: Map<string, PointInfo>,
  states: Map<string, MemoryState>,
  known: { id: string; text: string; topicId: string | null }[],
): ConnectionContent['partner'] | null {
  const learned = (id: string) => !byId.get(id)?.excluded && hasLearned((states.get(id) ?? UNLEARNED).stage);
  const byPosition = (ids: string[]) => ids.filter(learned).sort((a, b) => (byId.get(a)?.position ?? 0) - (byId.get(b)?.position ?? 0));
  const pointId = byPosition(point.prerequisiteIds).at(-1) ?? byPosition(point.confusableIds)[0];
  if (pointId) return { kind: 'point', id: pointId, title: byId.get(pointId)!.title };
  const existing = known.find((k) => k.topicId === point.topicId) ?? known[0];
  return existing ? { kind: 'existing', id: existing.id, title: existing.text } : null;
}

function connectionPrompt(title: string, partner: ConnectionContent['partner']): string {
  return partner.kind === 'point'
    ? `用你自己的话说说「${title}」和「${partner.title}」是什么关系：比如谁是谁的前提、有什么相同和不同、什么时候用哪个。一两句话就够。`
    : `用你自己的话说说「${title}」和你已经会的「${partner.title}」有什么联系：它们哪里相像、哪里不同，或者已经会的怎样帮你理解新的。一两句话就够。`;
}

/** 候选池中一项内容的形式，换算成重新生成时需要的形式 */
function needOf(item: PoolItem): PoolNeed {
  // 形式都是本系统生成内容时写入的，取值必在 EXPLAIN_FORMS / QUESTION_FORMS 中
  return item.kind === 'lesson'
    ? { kind: 'lesson', knowledgePointId: item.knowledgePointId, explainForm: item.form as ExplainForm, questionForm: item.questionForm as QuestionForm }
    : { kind: 'review', knowledgePointId: item.knowledgePointId, questionForm: item.form as QuestionForm };
}
