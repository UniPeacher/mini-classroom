import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { cognitiveEdge } from '../domain/edge';
import { hasLearned } from '../domain/memory';
import { enqueue } from '../jobs/queue';
import type { Settings } from '../settings';
import { DEFAULT_SUBJECT_STYLE, type SubjectStyleId, isSubjectStyleId } from '../shared/subject-styles';
import type { Db, Executor } from '../store/db';
import { readOrganizationMigrationReport } from '../store/legacy-organization';
import { loadPoints, loadStates } from '../store/repo';
import { courses, disciplines, items, knowledgePoints, memoryStates, topics } from '../store/schema';
import { describeCourseTeaching, guidanceForPreset, invalidateChangedTopics, resolveAllTopicTeaching, teachingFingerprint, teachingFingerprints } from '../teaching';
import { LearningError } from './views';

export interface OrganizationDeps {
  db: Db;
  /** 每次读取最新设置：共用引导词来自这里，学科预设补充在其后 */
  settings: () => Settings;
}

/** 影响评估的对象类型 */
export type ImpactKind = 'discipline' | 'course' | 'topics';

export interface ImpactInput {
  kind: ImpactKind;
  /** kind 为 discipline / course 时的目标 id */
  id?: string;
  /** 学科改用哪个预设 */
  presetId?: string;
  /** 课程改挂到哪个学科 */
  disciplineId?: string;
  /** kind 为 topics 时涉及的学习主题 */
  topicIds?: string[];
  /** 主题要归入的课程；null 表示取消归类 */
  courseId?: string | null;
}

/** 一个主题的知识点统计 */
interface TopicCounts {
  points: number;
  learned: number;
  due: number;
  excluded: number;
  /** 认知边缘：下一步可学的知识点数（图谱未就绪或主题暂停时为 0） */
  edge: number;
}

function readPreset(value: string | null | undefined): SubjectStyleId {
  return isSubjectStyleId(value) ? value : DEFAULT_SUBJECT_STYLE;
}

function assertPreset(value: string): SubjectStyleId {
  if (!isSubjectStyleId(value)) throw new LearningError('不认识的内容风格', 400);
  return value;
}

/** 每个主题的知识点统计：总数、已学会、到期、不学 */
function topicCounts(db: Executor, now: Date): Map<string, TopicCounts> {
  const states = loadStates(db);
  const rows = db
    .select({
      pointId: knowledgePoints.id,
      topicId: knowledgePoints.topicId,
      excluded: memoryStates.excluded,
    })
    .from(knowledgePoints)
    .innerJoin(memoryStates, eq(knowledgePoints.id, memoryStates.knowledgePointId))
    .all();
  const out = new Map<string, TopicCounts>();
  const entryOf = (topicId: string): TopicCounts => {
    const existing = out.get(topicId);
    if (existing) return existing;
    const created: TopicCounts = { points: 0, learned: 0, due: 0, excluded: 0, edge: 0 };
    out.set(topicId, created);
    return created;
  };
  for (const row of rows) {
    const entry = entryOf(row.topicId);
    entry.points += 1;
    if (row.excluded) entry.excluded += 1;
    const state = states.get(row.pointId);
    if (!state) continue;
    if (hasLearned(state.stage)) entry.learned += 1;
    if (!row.excluded && state.card && state.card.due.getTime() <= now.getTime()) entry.due += 1;
  }
  // 认知边缘与 assemble 用同一套规则：暂停的主题、摸底未完成的主题不新学
  for (const point of cognitiveEdge(loadPoints(db), states)) {
    if (point.topicId) entryOf(point.topicId).edge += 1;
  }
  return out;
}

function presetOfDiscipline(db: Executor, disciplineId: string | null): SubjectStyleId | null {
  if (!disciplineId) return null;
  const row = db.select({ presetId: disciplines.presetId }).from(disciplines).where(eq(disciplines.id, disciplineId)).get();
  return row ? readPreset(row.presetId) : null;
}

/**
 * 学科、课程与学习主题的稳定层级：
 * 学科(discipline) 选内容风格 → 课程(course) → 学习主题(topic)。
 * 修改组织关系只作废受影响主题尚未使用的内容，不改动作答记录、记忆状态和历史课堂。
 */
export function createOrganization({ db, settings: currentSettings }: OrganizationDeps) {
  // ---------- 读取 ----------

  /** 完整的组织视图：学科、课程、主题、未归类主题与升级迁移报告 */
  function overview(now: Date = new Date()) {
    const counts = topicCounts(db, now);
    const disciplineRows = db.select().from(disciplines).orderBy(asc(disciplines.createdAt), asc(disciplines.name)).all();
    const courseRows = db.select().from(courses).orderBy(asc(courses.createdAt), asc(courses.name)).all();
    const topicRows = db.select().from(topics).orderBy(asc(topics.createdAt)).all();
    const courseById = new Map(courseRows.map((c) => [c.id, c]));
    const disciplineNameOf = new Map(disciplineRows.map((d) => [d.id, d.name]));
    const emptyCounts: TopicCounts = { points: 0, learned: 0, due: 0, excluded: 0, edge: 0 };

    const topicView = (topic: (typeof topicRows)[number]) => {
      const course = topic.courseId ? courseById.get(topic.courseId) : undefined;
      const c = counts.get(topic.id) ?? emptyCounts;
      return {
        id: topic.id,
        title: topic.title,
        subject: topic.subject,
        courseId: topic.courseId ?? null,
        courseName: course?.name ?? null,
        disciplineId: course?.disciplineId ?? null,
        disciplineName: course ? (disciplineNameOf.get(course.disciplineId) ?? null) : null,
        status: topic.status,
        priority: topic.priority,
        graphStatus: topic.graphStatus,
        placementStatus: topic.placementStatus,
        createdAt: topic.createdAt,
        counts: { topics: 1, points: c.points, learned: c.learned, due: c.due, excluded: c.excluded, edge: c.edge },
      };
    };

    return {
      disciplines: disciplineRows.map((d) => {
        const ownCourses = courseRows.filter((c) => c.disciplineId === d.id);
        const ownTopics = topicRows.filter((t) => t.courseId && courseById.get(t.courseId)?.disciplineId === d.id);
        return {
          id: d.id,
          name: d.name,
          presetId: readPreset(d.presetId),
          createdAt: d.createdAt,
          counts: { courses: ownCourses.length, topics: ownTopics.length },
        };
      }),
      courses: courseRows.map((c) => {
        const own = topicRows.filter((t) => t.courseId === c.id);
        const sum = own.reduce(
          (acc, t) => {
            const s = counts.get(t.id) ?? emptyCounts;
            acc.topics += 1;
            acc.points += s.points;
            acc.learned += s.learned;
            acc.due += s.due;
            acc.excluded += s.excluded;
            acc.edge += s.edge;
            return acc;
          },
          { topics: 0, points: 0, learned: 0, due: 0, excluded: 0, edge: 0 },
        );
        return {
          id: c.id,
          name: c.name,
          disciplineId: c.disciplineId,
          disciplineName: disciplineNameOf.get(c.disciplineId) ?? null,
          createdAt: c.createdAt,
          counts: sum,
        };
      }),
      topics: topicRows.map(topicView),
      unclassifiedTopics: topicRows.filter((t) => !t.courseId).map(topicView),
      migrationReport: readOrganizationMigrationReport(db),
    };
  }

  // ---------- 影响评估（只读） ----------

  /** 这些主题在候选池里待学的内容条数（只有讲解与题目；联结练习和已用内容不算） */
  function pooledItemCount(topicIds: string[]): number {
    if (topicIds.length === 0) return 0;
    const pointIds = db
      .select({ id: knowledgePoints.id })
      .from(knowledgePoints)
      .where(inArray(knowledgePoints.topicId, topicIds))
      .all()
      .map((row) => row.id);
    if (pointIds.length === 0) return 0;
    return db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.status, 'pooled'), inArray(items.kind, ['lesson', 'review']), inArray(items.knowledgePointId, pointIds)))
      .all().length;
  }

  /**
   * 这次改动会让每个主题落到哪个预设。只对"预设真的不同"的主题给出目标预设，
   * 纯改名、换到同预设的学科/课程都不会出现条目。
   */
  function proposedPresets(input: ImpactInput): Map<string, SubjectStyleId> {
    const courseRows = db.select().from(courses).all();
    const disciplineRows = db.select().from(disciplines).all();
    const topicRows = db.select().from(topics).all();
    const disciplineById = new Map(disciplineRows.map((d) => [d.id, d]));
    const courseById = new Map(courseRows.map((c) => [c.id, c]));
    const out = new Map<string, SubjectStyleId>();

    if (input.kind === 'discipline') {
      if (!input.id || input.presetId === undefined) return out;
      const discipline = disciplineById.get(input.id);
      if (!discipline) return out;
      const target = assertPreset(input.presetId);
      if (target === readPreset(discipline.presetId)) return out;
      for (const course of courseRows.filter((c) => c.disciplineId === input.id)) {
        for (const topic of topicRows.filter((t) => t.courseId === course.id)) out.set(topic.id, target);
      }
      return out;
    }
    if (input.kind === 'course') {
      if (!input.id || input.disciplineId === undefined) return out;
      const target = disciplineById.get(input.disciplineId);
      if (!target) return out;
      for (const topic of topicRows.filter((t) => t.courseId === input.id)) out.set(topic.id, readPreset(target.presetId));
      return out;
    }
    if (!input.courseId) return out;
    const targetCourse = courseById.get(input.courseId);
    if (!targetCourse) return out;
    const targetPreset = readPreset(disciplineById.get(targetCourse.disciplineId)?.presetId);
    for (const topicId of input.topicIds ?? []) {
      if (topicRows.some((t) => t.id === topicId)) out.set(topicId, targetPreset);
    }
    return out;
  }

  /** 这次改动真正改变教学配置的主题：比较当前指纹与改动后应得的指纹 */
  function changedTopicsByTeaching(input: ImpactInput): string[] {
    const proposed = proposedPresets(input);
    if (proposed.size === 0) return [];
    const settings = currentSettings();
    const current = resolveAllTopicTeaching(db, settings);
    const changed: string[] = [];
    for (const [topicId, presetId] of proposed) {
      const before = current.get(topicId);
      if (!before) continue;
      const guidance = guidanceForPreset(settings.contentGuidance, presetId);
      if (teachingFingerprint(presetId, guidance) !== before.fingerprint) changed.push(topicId);
    }
    return changed;
  }

  /**
   * 保存前的影响评估：只读，不改变任何数据。
   *
   * 只统计教学内容真正会变的主题与课程：改名、换到预设相同的学科/课程都是 0。
   * 返回的计数是数字；明细在可选的 courseDetails / topicDetails 里。
   */
  function impact(input: ImpactInput) {
    const courseRows = db.select().from(courses).all();
    const topicRows = db.select().from(topics).all();
    const courseById = new Map(courseRows.map((c) => [c.id, c]));
    const changedTopics = changedTopicsByTeaching(input);
    const changedSet = new Set(changedTopics);
    const affectedCourses = new Set<string>();
    for (const topic of topicRows) {
      if (!changedSet.has(topic.id)) continue;
      if (topic.courseId) affectedCourses.add(topic.courseId);
    }
    // 目标归属本身也算进明细，即使它下面还没有主题
    if (input.kind === 'course' && input.id) affectedCourses.add(input.id);
    if (input.kind === 'topics' && input.courseId) affectedCourses.add(input.courseId);

    const affectedItems = pooledItemCount(changedTopics);
    return {
      kind: input.kind,
      affectedCourses: affectedCourses.size,
      affectedTopics: changedTopics.length,
      affectedItems,
      /** 是否需要重新调用模型：只有确实有待学内容被作废时才需要 */
      modelCalls: affectedItems > 0,
      /** 预期的模型调用次数，只作参考，不作为承诺 */
      estimatedModelCalls: affectedItems,
      courseDetails: [...affectedCourses].map((id) => ({
        id,
        name: courseById.get(id)?.name ?? '',
        disciplineId: courseById.get(id)?.disciplineId ?? null,
      })),
      topicDetails: changedTopics.map((id) => {
        const topic = topicRows.find((t) => t.id === id);
        return { id, title: topic?.title ?? '', courseId: topic?.courseId ?? null };
      }),
    };
  }

  /**
   * 改动组织关系：在同一个事务里比较改动前后每个主题的教学配置指纹，
   * 只作废真正受影响主题里尚未使用的内容；没有主题受影响时不补候选池（避免无谓的模型调用）。
   */
  function withTeachingChange<T>(now: Date, mutate: (tx: Executor) => T): T {
    return db.transaction((tx) => {
      const settings = currentSettings();
      const before = teachingFingerprints(tx, settings);
      const result = mutate(tx);
      const changed = invalidateChangedTopics(tx, before, teachingFingerprints(tx, currentSettings()));
      if (changed.length > 0) enqueue(tx, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
      return result;
    });
  }

  // ---------- 学科 ----------

  function createDiscipline(input: { name: string; presetId?: string }, now: Date) {
    const name = input.name.trim();
    if (!name) throw new LearningError('学科名称不能为空', 400);
    if (db.select().from(disciplines).where(eq(disciplines.name, name)).get()) throw new LearningError('已有同名学科', 409);
    const presetId = input.presetId === undefined ? DEFAULT_SUBJECT_STYLE : assertPreset(input.presetId);
    const id = randomUUID();
    db.insert(disciplines).values({ id, name, presetId, createdAt: now }).run();
    return db.select().from(disciplines).where(eq(disciplines.id, id)).get()!;
  }

  /**
   * 修改学科：改名或换内容风格。
   * 只有确实会作废待学内容（预设变了且这些主题里有候选内容）时才要求确认；
   * 改名、换成相同预设、或学科下还没备好任何内容时可以直接保存。
   */
  function updateDiscipline(id: string, patch: { name?: string; presetId?: string; confirmed?: boolean }, now: Date) {
    const discipline = db.select().from(disciplines).where(eq(disciplines.id, id)).get();
    if (!discipline) throw new LearningError('学科不存在', 404);
    const next: { name?: string; presetId?: string } = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new LearningError('学科名称不能为空', 400);
      const same = db.select().from(disciplines).where(eq(disciplines.name, name)).get();
      if (same && same.id !== id) throw new LearningError('已有同名学科', 409);
      if (name !== discipline.name) next.name = name;
    }
    if (patch.presetId !== undefined) {
      const presetId = assertPreset(patch.presetId);
      if (presetId !== discipline.presetId) next.presetId = presetId;
    }
    if (Object.keys(next).length === 0) return discipline;

    // 只有真的有待学内容会被作废时才需要确认：新学科或没有候选内容时直接保存
    if (next.presetId !== undefined && !patch.confirmed) {
      const { affectedItems } = impact({ kind: 'discipline', id, presetId: next.presetId });
      if (affectedItems > 0) {
        throw new LearningError('更换内容风格会作废该学科下的待学内容，请先确认影响范围', 409);
      }
    }
    return withTeachingChange(now, (tx) => {
      tx.update(disciplines).set(next).where(eq(disciplines.id, id)).run();
      return tx.select().from(disciplines).where(eq(disciplines.id, id)).get()!;
    });
  }

  /** 只有既没有课程、也没有主题的学科才能删除 */
  function deleteDiscipline(id: string) {
    const discipline = db.select().from(disciplines).where(eq(disciplines.id, id)).get();
    if (!discipline) throw new LearningError('学科不存在', 404);
    const courseIds = db.select({ id: courses.id }).from(courses).where(eq(courses.disciplineId, id)).all().map((c) => c.id);
    if (courseIds.length > 0) {
      const used = db.select({ id: topics.id }).from(topics).where(inArray(topics.courseId, courseIds)).all();
      throw new LearningError(
        used.length > 0 ? '这个学科下还有学习主题，先移走或删除它们' : '这个学科下还有课程，先删除课程',
        409,
      );
    }
    db.delete(disciplines).where(eq(disciplines.id, id)).run();
    return { ok: true };
  }

  // ---------- 课程 ----------

  function createCourse(input: { name: string; disciplineId: string }, now: Date) {
    const name = input.name.trim();
    if (!name) throw new LearningError('课程名称不能为空', 400);
    if (!db.select().from(disciplines).where(eq(disciplines.id, input.disciplineId)).get()) {
      throw new LearningError('学科不存在', 404);
    }
    if (db.select().from(courses).where(and(eq(courses.disciplineId, input.disciplineId), eq(courses.name, name))).get()) {
      throw new LearningError('这个学科下已有同名课程', 409);
    }
    const id = randomUUID();
    db.insert(courses).values({ id, disciplineId: input.disciplineId, name, createdAt: now }).run();
    return db.select().from(courses).where(eq(courses.id, id)).get()!;
  }

  /**
   * 修改课程：改名或改挂到别的学科。改挂后预设不同会改变这些主题的讲法，
   * 必须先看过影响评估再明确确认；确认后只作废这些主题的待学内容。
   */
  function updateCourse(id: string, patch: { name?: string; disciplineId?: string; confirmed?: boolean }, now: Date) {
    const course = db.select().from(courses).where(eq(courses.id, id)).get();
    if (!course) throw new LearningError('课程不存在', 404);
    const next: { name?: string; disciplineId?: string } = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new LearningError('课程名称不能为空', 400);
      if (name !== course.name) next.name = name;
    }
    if (patch.disciplineId !== undefined) {
      if (!db.select().from(disciplines).where(eq(disciplines.id, patch.disciplineId)).get()) {
        throw new LearningError('学科不存在', 404);
      }
      if (patch.disciplineId !== course.disciplineId) next.disciplineId = patch.disciplineId;
    }
    if (Object.keys(next).length === 0) return course;

    if (next.disciplineId !== undefined) {
      const presetBefore = presetOfDiscipline(db, course.disciplineId);
      const presetAfter = presetOfDiscipline(db, next.disciplineId);
      // 换到预设相同的学科时讲法没变，不必确认也不用重新备内容
      if (presetBefore !== presetAfter && !patch.confirmed) {
        const { affectedItems } = impact({ kind: 'course', id, disciplineId: next.disciplineId });
        if (affectedItems > 0) {
          throw new LearningError('换到别的学科会作废这些主题的待学内容，请先确认影响范围', 409);
        }
      }
    }
    return withTeachingChange(now, (tx) => {
      tx.update(courses).set(next).where(eq(courses.id, id)).run();
      return tx.select().from(courses).where(eq(courses.id, id)).get()!;
    });
  }

  /** 只有没有学习主题的课程才能删除 */
  function deleteCourse(id: string) {
    const course = db.select().from(courses).where(eq(courses.id, id)).get();
    if (!course) throw new LearningError('课程不存在', 404);
    const used = db.select({ id: topics.id }).from(topics).where(eq(topics.courseId, id)).all();
    if (used.length > 0) throw new LearningError('这门课程下还有学习主题，先把它们移到别的课程或不归类', 409);
    db.delete(courses).where(eq(courses.id, id)).run();
    return { ok: true };
  }

  /** 把列出的主题归入这门课程；未列出的主题保持原归属，不整体替换 */
  function assignTopics(courseId: string, topicIds: string[], now: Date) {
    if (!db.select().from(courses).where(eq(courses.id, courseId)).get()) throw new LearningError('课程不存在', 404);
    const ids = [...new Set(topicIds)];
    if (ids.length === 0) return { assigned: 0, topics: [] as string[] };
    const existing = db.select({ id: topics.id, courseId: topics.courseId }).from(topics).where(inArray(topics.id, ids)).all();
    if (existing.length !== ids.length) throw new LearningError('有学习主题不存在', 404);
    const changed = existing.filter((t) => t.courseId !== courseId).map((t) => t.id);
    if (changed.length === 0) return { assigned: 0, topics: [] as string[] };
    // 归属变化可能换了内容风格：只作废真正受影响主题里尚未使用的内容
    withTeachingChange(now, (tx) => {
      tx.update(topics).set({ courseId }).where(inArray(topics.id, changed)).run();
    });
    return { assigned: changed.length, topics: changed };
  }

  // ---------- 教学引导词 ----------

  /**
   * 某门课程实际生效的教学引导词：所属学科的预设 + 共用表达规则。
   * id 为 unclassified（或 none）时返回未归类主题用的那一份，只有共用规则。
   */
  function guidance(courseId: string) {
    const settings = currentSettings();
    const key = courseId === 'unclassified' || courseId === 'none' ? null : courseId;
    const description = describeCourseTeaching(db, key, settings);
    if (!description) throw new LearningError('课程不存在', 404);
    return description;
  }

  return {
    overview,
    impact,
    createDiscipline,
    updateDiscipline,
    deleteDiscipline,
    createCourse,
    updateCourse,
    deleteCourse,
    assignTopics,
    guidance,
  };
}

export type Organization = ReturnType<typeof createOrganization>;
