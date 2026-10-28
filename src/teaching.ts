import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Settings } from './settings';
import type { ContentGuidance } from './shared/content-guidance';
import {
  DEFAULT_SUBJECT_STYLE,
  SUBJECT_STYLE_INFO,
  type SubjectStyleId,
  composeTeachingGuidance,
  isSubjectStyleId,
  subjectStyleVersion,
} from './shared/subject-styles';
import type { Executor } from './store/db';
import { courses, disciplines, items, knowledgePoints, topics } from './store/schema';

/**
 * 教学配置的集中解析：某个学习主题（或知识点）此刻实际使用的学科、课程、内容风格预设与引导词。
 *
 * 运行期只有这一条解析链：学科(discipline) → 课程(course) → 学习主题(topic)。
 * 风格只来自学科选定的预设；没有课程的主题按未归类处理，只使用共用引导词。
 * 设置里的旧分组、逐标签覆盖、旧扁平映射都不参与运行期解析（只在升级迁移时读取）。
 *
 * 引导词 = 共用表达规则 + 学科预设的补充要求（预设只追加，不替换）。
 * 指纹只看会改变生成内容的因素（预设 id、预设正文版本、合并后的引导词），
 * 不含学科名、课程名或任何 id：改名、把课程换到同预设的学科都不会让内容失效。
 */
export interface TeachingConfig {
  /** 内容风格预设；default 表示只用共用引导词 */
  presetId: SubjectStyleId;
  /** 所属课程；主题还没归入课程时为 null */
  courseId: string | null;
  /** 所属学科；通过课程推导，未归类时为 null */
  disciplineId: string | null;
  /** 这个主题实际生效的引导词 */
  guidance: ContentGuidance;
  /** 教学配置指纹：预设或引导词变了，指纹就变 */
  fingerprint: string;
}

/** 某门课程（或未归类）的教学配置详情，供"查看实际引导词"页面使用 */
export interface CourseTeachingDescription {
  courseId: string | null;
  courseName: string;
  disciplineId: string | null;
  disciplineName: string | null;
  presetId: SubjectStyleId;
  presetLabel: string;
  /** 合并后的教程引导词（共用规则 + 预设补充），与生成端逐字一致 */
  tutorialGuidance: string;
  /** 合并后的配图引导词（共用规则 + 预设补充），与生成端逐字一致 */
  figureGuidance: string;
  fingerprint: string;
}

/** 未归类主题在预览与详情里的展示名 */
export const UNCLASSIFIED_TEACHING_NAME = '未归类';

/** 指纹算法版本：改变指纹构成时才递增，避免与历史内容误判为相同 */
const FINGERPRINT_VERSION = 2;

/** 预设 id 不合法时退回通用；改坏的数据不会套用其它学科的要求 */
function readPreset(value: string | null | undefined): SubjectStyleId {
  return isSubjectStyleId(value) ? value : DEFAULT_SUBJECT_STYLE;
}

/**
 * 生成端与预览共用的唯一合成入口：共用引导词 + 学科预设的补充要求。
 * default 预设不追加任何内容，结果与只用共用规则时逐字相同。
 */
export function guidanceForPreset(base: ContentGuidance, presetId: SubjectStyleId): ContentGuidance {
  return composeTeachingGuidance(base, presetId);
}

/**
 * 教学配置指纹：只看会改变生成内容的因素，避免无关改动引起内容作废。
 * 不含学科名、课程名和任何 id：改名不触发重新备课。
 */
export function teachingFingerprint(presetId: SubjectStyleId, guidance: ContentGuidance): string {
  return createHash('sha256')
    .update(
      [
        `v${FINGERPRINT_VERSION}`,
        presetId,
        `${presetId}@${subjectStyleVersion(presetId)}`,
        guidance.tutorialGuidance,
        guidance.figureGuidance,
      ].join('\n'),
    )
    .digest('hex')
    .slice(0, 32);
}

interface TopicOrganization {
  courseId: string | null;
  disciplineId: string | null;
  presetId: string | null;
}

/** 一次取出主题的组织归属，避免逐条查询 */
function organizationOf(db: Executor, topicIds: string[]): Map<string, TopicOrganization> {
  if (topicIds.length === 0) return new Map();
  const rows = db
    .select({
      topicId: topics.id,
      courseId: topics.courseId,
      disciplineId: courses.disciplineId,
      presetId: disciplines.presetId,
    })
    .from(topics)
    .leftJoin(courses, eq(topics.courseId, courses.id))
    .leftJoin(disciplines, eq(courses.disciplineId, disciplines.id))
    .where(inArray(topics.id, topicIds))
    .all();
  return new Map(rows.map((row) => [row.topicId, row]));
}

function configOf(row: TopicOrganization | undefined, settings: Settings): TeachingConfig {
  const presetId = readPreset(row?.presetId);
  const guidance = guidanceForPreset(settings.contentGuidance, presetId);
  return {
    presetId,
    courseId: row?.courseId ?? null,
    disciplineId: row?.disciplineId ?? null,
    guidance,
    fingerprint: teachingFingerprint(presetId, guidance),
  };
}

/** 某个学习主题此刻的教学配置；主题不存在时按未归类处理（调用方通常已校验） */
export function resolveTopicTeaching(db: Executor, topicId: string, settings: Settings): TeachingConfig {
  return configOf(organizationOf(db, [topicId]).get(topicId), settings);
}

/** 某个知识点此刻的教学配置：沿知识点 → 主题 → 课程 → 学科解析 */
export function resolvePointTeaching(db: Executor, pointId: string, settings: Settings): TeachingConfig {
  const row = db.select({ topicId: knowledgePoints.topicId }).from(knowledgePoints).where(eq(knowledgePoints.id, pointId)).get();
  return row ? resolveTopicTeaching(db, row.topicId, settings) : configOf(undefined, settings);
}

/** 批量解析每个主题当前的教学配置：补候选池、重新生成、预览都按这一份判断内容是否过期 */
export function resolveAllTopicTeaching(db: Executor, settings: Settings): Map<string, TeachingConfig> {
  const ids = db.select({ id: topics.id }).from(topics).all().map((row) => row.id);
  const rows = organizationOf(db, ids);
  return new Map(ids.map((id) => [id, configOf(rows.get(id), settings)]));
}

/** 主题 → 教学配置指纹，用于修改组织关系前后比较哪些主题真的受影响了 */
export function teachingFingerprints(db: Executor, settings: Settings): Map<string, string> {
  const map = new Map<string, string>();
  for (const [topicId, config] of resolveAllTopicTeaching(db, settings)) map.set(topicId, config.fingerprint);
  return map;
}

/** 对比前后两份指纹，返回实际受影响（教学配置变了）的主题 */
export function changedTopicIds(before: Map<string, string>, after: Map<string, string>): string[] {
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids].filter((id) => before.get(id) !== after.get(id));
}

/**
 * 这个知识点当前的教学配置是否已经与生成时不同。
 *
 * `before` 是生成时实际记下的指纹；旧内容没有指纹（null）。
 * 没有指纹时一律按"没有变化"处理：不因升级自动作废或重新生成已备好的内容。
 * 新生成的内容总是记下指纹，之后的配置改动才会被判为过期。
 *
 * 知识点已经不存在时返回 true：生成期间被删除的内容不能再入池，否则写库会撞外键。
 * 只看生成内容是否过期；课程归属变了但预设没变时指纹不变，范围变化用
 * teachingScopeChanged 单独判断（见下）。
 */
export function teachingChanged(db: Executor, pointId: string, settings: Settings, before: string | null | undefined): boolean {
  const exists = db.select({ id: knowledgePoints.id }).from(knowledgePoints).where(eq(knowledgePoints.id, pointId)).get();
  if (!exists) return true;
  if (before === null || before === undefined) return false;
  return resolvePointTeaching(db, pointId, settings).fingerprint !== before;
}

/** 教学配置的归属范围：课程与学科决定一节的范围过滤，但不影响生成内容的文字 */
export interface TeachingScope {
  courseId: string | null;
  disciplineId: string | null;
}

/** 某个知识点此刻的归属范围（课程、学科），只读组织关系，不涉及引导词 */
export function teachingScopeOf(db: Executor, pointId: string): TeachingScope {
  const row = db
    .select({ topicId: knowledgePoints.topicId })
    .from(knowledgePoints)
    .where(eq(knowledgePoints.id, pointId))
    .get();
  if (!row) return { courseId: null, disciplineId: null };
  const org = organizationOf(db, [row.topicId]).get(row.topicId);
  return { courseId: org?.courseId ?? null, disciplineId: org?.disciplineId ?? null };
}

/**
 * 归属范围是否已经与生成时不同。
 *
 * 把课程移到同一预设的另一个学科、或把主题归入别的课程时，生成内容的文字仍然符合要求
 * （指纹不变，不必重新生成），但"这一节学哪些主题"的范围判断已经变了，
 * 保存前要用这个函数重新确认，避免把已不在范围内的内容建进课堂。
 * 知识点不存在时返回 true。
 */
export function teachingScopeChanged(db: Executor, pointId: string, before: TeachingScope): boolean {
  const now = teachingScopeOf(db, pointId);
  return now.courseId !== before.courseId || now.disciplineId !== before.disciplineId;
}

/**
 * 作废这些主题下尚未使用的内容（只有候选池里的讲解和题目）。
 * 已使用的内容、作答记录、进行中的课堂、插画和记忆状态都不动。
 */
export function invalidatePooledForTopics(db: Executor, topicIds: string[]): number {
  if (topicIds.length === 0) return 0;
  const pointIds = db
    .select({ id: knowledgePoints.id })
    .from(knowledgePoints)
    .where(inArray(knowledgePoints.topicId, topicIds))
    .all()
    .map((row) => row.id);
  if (pointIds.length === 0) return 0;
  return db
    .update(items)
    .set({ status: 'void' })
    .where(and(eq(items.status, 'pooled'), inArray(items.kind, ['lesson', 'review']), inArray(items.knowledgePointId, pointIds)))
    .run().changes;
}

/**
 * 统一的内容失效入口：按前后两份指纹只作废真正受影响的主题。
 * 返回受影响的主题 id，调用方据此决定是否补候选池（为空时不补，避免无谓的模型调用）。
 */
export function invalidateChangedTopics(db: Executor, before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = changedTopicIds(before, after);
  if (changed.length > 0) invalidatePooledForTopics(db, changed);
  return changed;
}

/**
 * 旧内容的一次性指纹标注：给升级前生成的候选内容补上按当前配置计算的基线指纹。
 *
 * 只写 guidance_fingerprint 这一列，不改状态、不删除内容、不重新生成、不入队任务；
 * 已使用的内容、作答记录、历史课堂与记忆状态完全不动。
 * 只处理仍然为 null 的行，重复执行不会产生新变化。返回被标注的条数。
 *
 * 迁移只需要调用一次（或由后台在合适时机调用），日常流程不依赖它：
 * 即使从不标注，`teachingChanged` 也会把 null 当作"没有变化"，不会引起自动重新生成。
 */
export function adoptLegacyFingerprints(db: Executor, settings: Settings): number {
  const rows = db
    .select({ id: items.id, topicId: knowledgePoints.topicId })
    .from(items)
    .innerJoin(knowledgePoints, eq(items.knowledgePointId, knowledgePoints.id))
    .where(and(isNull(items.guidanceFingerprint), inArray(items.kind, ['lesson', 'review'])))
    .all();
  if (rows.length === 0) return 0;
  const fingerprints = teachingFingerprints(db, settings);
  return db.transaction((tx) => {
    let changed = 0;
    for (const row of rows) {
      const fingerprint = fingerprints.get(row.topicId);
      if (!fingerprint) continue;
      changed += tx
        .update(items)
        .set({ guidanceFingerprint: fingerprint })
        .where(and(eq(items.id, row.id), isNull(items.guidanceFingerprint)))
        .run().changes;
    }
    return changed;
  });
}

function describeOf(
  org: { courseId: string | null; courseName: string; disciplineId: string | null; disciplineName: string | null; presetId: string | null },
  settings: Settings,
): CourseTeachingDescription {
  const presetId = readPreset(org.presetId);
  const guidance = guidanceForPreset(settings.contentGuidance, presetId);
  return {
    courseId: org.courseId,
    courseName: org.courseName,
    disciplineId: org.disciplineId,
    disciplineName: org.disciplineName,
    presetId,
    presetLabel: SUBJECT_STYLE_INFO[presetId].label,
    tutorialGuidance: guidance.tutorialGuidance,
    figureGuidance: guidance.figureGuidance,
    fingerprint: teachingFingerprint(presetId, guidance),
  };
}

/**
 * 某门课程的教学配置详情：所属学科、预设与合并后的引导词，供提示词预览接口使用。
 *
 * `courseId` 为 null（或界面传入的 unclassified）表示未归类主题：只有共用引导词，预设为通用。
 * 课程不存在时返回 null，由接口层映射为 404。
 */
export function describeCourseTeaching(
  db: Executor,
  courseId: string | null,
  settings: Settings,
): CourseTeachingDescription | null {
  if (courseId === null) {
    return describeOf(
      { courseId: null, courseName: UNCLASSIFIED_TEACHING_NAME, disciplineId: null, disciplineName: null, presetId: null },
      settings,
    );
  }
  const row = db
    .select({
      courseId: courses.id,
      courseName: courses.name,
      disciplineId: disciplines.id,
      disciplineName: disciplines.name,
      presetId: disciplines.presetId,
    })
    .from(courses)
    .leftJoin(disciplines, eq(courses.disciplineId, disciplines.id))
    .where(eq(courses.id, courseId))
    .get();
  if (!row) return null;
  return describeOf(
    {
      courseId: row.courseId,
      courseName: row.courseName,
      disciplineId: row.disciplineId ?? null,
      disciplineName: row.disciplineName ?? null,
      presetId: row.presetId ?? null,
    },
    settings,
  );
}
