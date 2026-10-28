import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { isSubjectStyleId, type SubjectStyleId } from '../shared/subject-styles';
import type { Db } from './db';
import { appSettings, courses, disciplines, topics } from './schema';

/**
 * 旧版把学科组织成"主题上的自由标签 + 设置里的分组/逐标签风格"。
 * 现在改为 学科(discipline) → 课程(course) → 学习主题(topic) 的固定层级，
 * 风格只由学科的内容风格预设决定。升级时把旧配置转换成这层结构，并保留原始配置备查。
 *
 * 迁移在数据库打开时执行一次，结果与原始配置一起写入 app_settings；
 * 整个迁移（结构与报告）在一个事务里完成，重复执行不会产生新记录。
 */
export const ORGANIZATION_MIGRATION_KEY = 'organization_migration_v1';

/** 原始设置里与学科组织有关的三个键；原样保留，不做清洗 */
const LEGACY_SETTING_KEYS = ['subjectGroups', 'tagStyles', 'subjectStyles'] as const;

export type LegacyMappingSource = 'group' | 'override' | 'legacy' | 'default';

export interface OrganizationMigrationMapping {
  /** 旧的学科标签 */
  tag: string;
  disciplineId: string;
  courseId: string;
  presetId: SubjectStyleId;
  /** 这个风格是从哪一级配置来的：分组、标签自身覆盖、旧扁平映射，或没有配置 */
  source: LegacyMappingSource;
}

export interface OrganizationMigrationReport {
  version: 1;
  migratedAt: string;
  source: {
    /** 旧配置里出现的全部学科标签（含只出现在配置里、没有主题的） */
    subjects: string[];
    groupCount: number;
    tagStyleCount: number;
    legacyStyleCount: number;
  };
  created: { disciplines: number; courses: number };
  /** 迁移时归入课程的学习主题数 */
  topicsAssigned: number;
  mappings: OrganizationMigrationMapping[];
  /** 无法转换或被合并掉的配置项 */
  ignored: { tag: string; reason: string }[];
  /** 原始配置快照：保留未清洗的原始值，供用户核对与问题排查 */
  archived: {
    /** 迁移时的完整设置对象（含未知字段与非法值） */
    userSettings: unknown;
    /** 其中与学科组织有关的三个原始值 */
    legacy: Record<string, unknown>;
  };
}

interface NormalizedGroup {
  name: string;
  presetId: SubjectStyleId;
  /** 去空白、去重后的标签，保持原顺序 */
  subjects: string[];
}

/**
 * 固定 id：用哈希而不是拼字符串，避免 "A:B"/"C" 与 "A"/"B:C" 这类组合撞在同一个 id 上。
 * 同一份旧配置每次算出的 id 相同，重复执行不会产生重复记录。
 */
function stableId(prefix: 'discipline' | 'course', kind: 'group' | 'tag', name: string): string {
  const digest = createHash('sha256').update(`${kind}\u0000${name}`).digest('hex').slice(0, 24);
  return `legacy-${prefix}-${digest}`;
}

/** 从任意 JSON 里安全地取字符串表；旧配置可能被手工改坏。键做 trim，值必须是非空字符串 */
function rawStringRecord(value: unknown): { entries: Record<string, string>; invalid: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { entries: {}, invalid: 0 };
  const entries: Record<string, string> = {};
  let invalid = 0;
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key || typeof rawValue !== 'string') {
      invalid += 1;
      continue;
    }
    // 同一标签的不同写法（前后空白）按第一个出现的为准
    if (!(key in entries)) entries[key] = rawValue;
  }
  return { entries, invalid };
}

/** 旧分组：只保留名字非空的分组，组内标签去空白、去重；同名分组只取第一个 */
function normalizeGroups(value: unknown): { groups: NormalizedGroup[]; ignored: OrganizationMigrationReport['ignored'] } {
  const ignored: OrganizationMigrationReport['ignored'] = [];
  if (!Array.isArray(value)) return { groups: [], ignored };
  const groups: NormalizedGroup[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;
    if (seen.has(name)) {
      ignored.push({ tag: name, reason: '重复的分组名，只保留第一个分组' });
      continue;
    }
    seen.add(name);
    const styleId = record.styleId;
    if (!isSubjectStyleId(styleId)) ignored.push({ tag: name, reason: '不认识的学科预设，按通用处理' });
    const subjects = Array.isArray(record.subjects)
      ? [...new Set(record.subjects.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean))]
      : [];
    groups.push({ name, presetId: isSubjectStyleId(styleId) ? styleId : 'default', subjects });
  }
  return { groups, ignored };
}

function readRawSetting(db: Db, key: string): unknown {
  const row = db.select().from(appSettings).where(eq(appSettings.key, 'user_settings')).get();
  const value = row?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** 已迁移过时返回上次的报告，不重复执行 */
export function readOrganizationMigrationReport(db: Db): OrganizationMigrationReport | null {
  const row = db.select().from(appSettings).where(eq(appSettings.key, ORGANIZATION_MIGRATION_KEY)).get();
  const value = row?.value as { report?: OrganizationMigrationReport } | null | undefined;
  return value?.report ?? null;
}

/**
 * 判断这份数据库是否具备迁移所需的表结构。
 * 桌面版的"旧版数据库导入"会用更早的迁移目录打开数据库，那时还没有 topics.subject 与组织表。
 */
function canMigrate(db: Db): boolean {
  const columns = db.$client.pragma('table_info(topics)') as { name: string }[];
  const tables = db.$client.pragma("table_list") as { name: string }[];
  const names = new Set(tables.map((t) => t.name));
  return columns.some((c) => c.name === 'subject') && names.has('disciplines') && names.has('courses');
}

/**
 * 把旧版学科标签与风格配置迁移为学科/课程。
 *
 * 旧配置的生效优先级（与升级前的运行期一致，高到低）：
 * 1. 标签自己的风格覆盖（tagStyles）；
 * 2. 标签所在分组的风格（subjectGroups，多个分组包含同一标签时以第一个为准）；
 * 3. 旧版扁平映射（subjectStyles）；
 * 4. 通用。
 *
 * 转换规则：
 * - 每个分组成为一个学科，分组选的风格即学科的内容风格；组内标签成为课程；
 * - 标签自己的覆盖与分组风格相同：仍归在这个分组的学科下，行为不变，不额外造学科；
 * - 标签自己的覆盖与分组不同：单独建一个明确标识的兼容学科承载它，保持原来的讲法；
 * - 不在任何分组里的标签：按覆盖 / 旧扁平映射 / 通用的顺序取风格建学科；
 * - 主题按标签归入对应课程；已经有课程的主题不改动。
 *
 * 只改组织结构：不生成内容、不入队任务、不作废候选项、不改动学习历史与记忆状态。
 * 返回本次执行的报告；已迁移过或没有旧配置时返回 null。
 */
export function migrateLegacyOrganization(db: Db, now: Date): OrganizationMigrationReport | null {
  // 先确认表结构：桌面版导入会用更早的迁移目录打开数据库，那时还没有这些表
  if (!canMigrate(db)) return null;
  if (readOrganizationMigrationReport(db)) return null;

  const rawTagStyles = readRawSetting(db, 'tagStyles');
  const rawSubjectStyles = readRawSetting(db, 'subjectStyles');
  const rawGroups = readRawSetting(db, 'subjectGroups');
  const tagStyles = rawStringRecord(rawTagStyles);
  const subjectStyles = rawStringRecord(rawSubjectStyles);
  const { groups, ignored } = normalizeGroups(rawGroups);

  const topicSubjects = [
    ...new Set(
      db
        .select({ subject: topics.subject })
        .from(topics)
        .all()
        .map((row) => row.subject?.trim())
        .filter((s): s is string => !!s),
    ),
  ];

  // 没有任何旧组织配置时什么都不写：空库要保持"没有用户记录"，仍允许导入旧版记录。
  if (
    groups.length === 0 &&
    Object.keys(tagStyles.entries).length === 0 &&
    Object.keys(subjectStyles.entries).length === 0 &&
    topicSubjects.length === 0
  ) {
    return null;
  }

  // 标签 → 第一个包含它的分组；与升级前的 groupOfTag 一致
  const groupOfTag = new Map<string, NormalizedGroup>();
  for (const group of groups) {
    for (const subject of group.subjects) {
      if (!groupOfTag.has(subject)) groupOfTag.set(subject, group);
    }
  }

  const allTags = new Set<string>([
    ...groups.flatMap((g) => g.subjects),
    ...Object.keys(tagStyles.entries),
    ...Object.keys(subjectStyles.entries),
    ...topicSubjects,
  ]);

  const report: OrganizationMigrationReport = {
    version: 1,
    migratedAt: now.toISOString(),
    source: {
      subjects: [...allTags].sort((a, b) => a.localeCompare(b, 'zh-CN')),
      groupCount: groups.length,
      tagStyleCount: Object.keys(tagStyles.entries).length,
      legacyStyleCount: Object.keys(subjectStyles.entries).length,
    },
    created: { disciplines: 0, courses: 0 },
    topicsAssigned: 0,
    mappings: [],
    ignored,
    archived: { userSettings: readStoredSettings(db), legacy: { subjectGroups: rawGroups, tagStyles: rawTagStyles, subjectStyles: rawSubjectStyles } },
  };

  const courseOfTag = new Map<string, string>();
  const mappedTags = new Set<string>();

  db.transaction((tx) => {
    const txEnsureDiscipline = (id: string, name: string, presetId: SubjectStyleId) => {
      const result = tx.insert(disciplines).values({ id, name, presetId, createdAt: now }).onConflictDoNothing().run();
      if (result.changes > 0) report.created.disciplines += 1;
    };
    const txEnsureCourse = (id: string, disciplineId: string, name: string) => {
      const result = tx.insert(courses).values({ id, disciplineId, name, createdAt: now }).onConflictDoNothing().run();
      if (result.changes > 0) report.created.courses += 1;
      else {
        const existing = tx.select({ disciplineId: courses.disciplineId }).from(courses).where(eq(courses.id, id)).get();
        if (existing && existing.disciplineId !== disciplineId) {
          ignored.push({ tag: name, reason: '同名标签指向不同学科，沿用已存在的课程归属' });
        }
      }
    };

    // 1. 分组 → 学科；组内标签 → 课程
    for (const group of groups) {
      const groupDisciplineId = stableId('discipline', 'group', group.name);
      txEnsureDiscipline(groupDisciplineId, group.name, group.presetId);
      for (const tag of group.subjects) {
        if (mappedTags.has(tag)) {
          // 多个分组都包含同一标签：按升级前的优先级只取第一个分组
          ignored.push({ tag, reason: '这个标签出现在多个分组里，按第一个分组归入课程' });
          continue;
        }
        const ownStyle = tagStyles.entries[tag];
        const hasOwn = isSubjectStyleId(ownStyle);
        if (hasOwn && ownStyle !== group.presetId) {
          // 覆盖与分组不同：单独建一个明确标识的兼容学科，保留它原来的生效方式
          const disciplineId = stableId('discipline', 'tag', tag);
          const courseId = stableId('course', 'tag', tag);
          txEnsureDiscipline(disciplineId, `${tag}（独立预设）`, ownStyle);
          txEnsureCourse(courseId, disciplineId, tag);
          courseOfTag.set(tag, courseId);
          mappedTags.add(tag);
          report.mappings.push({ tag, disciplineId, courseId, presetId: ownStyle, source: 'override' });
          continue;
        }
        // 没有覆盖，或覆盖与分组相同：归在分组学科下，讲法与升级前一致
        const courseId = stableId('course', 'group', tag);
        txEnsureCourse(courseId, groupDisciplineId, tag);
        courseOfTag.set(tag, courseId);
        mappedTags.add(tag);
        report.mappings.push({
          tag,
          disciplineId: groupDisciplineId,
          courseId,
          presetId: group.presetId,
          source: hasOwn ? 'override' : 'group',
        });
      }
    }

    // 2. 不在分组里的标签：按覆盖、旧扁平映射、通用的顺序取风格
    const looseTags = [...allTags].filter((tag) => !mappedTags.has(tag)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    for (const tag of looseTags) {
      const own = tagStyles.entries[tag];
      const legacy = subjectStyles.entries[tag];
      const ownValid = isSubjectStyleId(own);
      const legacyValid = isSubjectStyleId(legacy);
      // 配置里写了不认识的预设：记录下来，按通用处理
      if (own !== undefined && !ownValid) ignored.push({ tag, reason: `不认识的学科预设「${own}」，按通用处理` });
      if (legacy !== undefined && !legacyValid) ignored.push({ tag, reason: `旧扁平映射里的预设「${legacy}」不认识，按通用处理` });
      const presetId: SubjectStyleId | null = ownValid ? own : legacyValid ? legacy : null;
      // 只出现在配置里、没有对应主题、风格也不认识：没有可迁移的内容
      if (presetId === null && !topicSubjects.includes(tag)) {
        ignored.push({ tag, reason: '没有学习主题使用这个标签，风格也不认识，未迁移' });
        continue;
      }
      const disciplineId = stableId('discipline', 'tag', tag);
      const courseId = stableId('course', 'tag', tag);
      txEnsureDiscipline(disciplineId, tag, presetId ?? 'default');
      txEnsureCourse(courseId, disciplineId, tag);
      courseOfTag.set(tag, courseId);
      report.mappings.push({
        tag,
        disciplineId,
        courseId,
        presetId: presetId ?? 'default',
        source: ownValid ? 'override' : legacyValid ? 'legacy' : 'default',
      });
    }

    // 3. 主题归入课程：只补还没有课程的，已有组织关系的不动
    const unassigned = tx.select({ id: topics.id, subject: topics.subject }).from(topics).where(isNull(topics.courseId)).all();
    for (const row of unassigned) {
      const tag = row.subject?.trim();
      const courseId = tag ? courseOfTag.get(tag) : undefined;
      if (!courseId) continue;
      const result = tx.update(topics).set({ courseId }).where(and(eq(topics.id, row.id), isNull(topics.courseId))).run();
      report.topicsAssigned += result.changes;
    }

    // 4. 报告与标记：和上面的结构改动在同一个事务里提交
    tx.insert(appSettings)
      .values({ key: ORGANIZATION_MIGRATION_KEY, value: { report }, updatedAt: now })
      .onConflictDoNothing()
      .run();
  });
  return report;
}

/** 存储的完整设置对象，原样保留 */
function readStoredSettings(db: Db): unknown {
  const row = db.select().from(appSettings).where(eq(appSettings.key, 'user_settings')).get();
  return row?.value ?? null;
}

export { LEGACY_SETTING_KEYS };
