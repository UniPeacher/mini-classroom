import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Settings } from '../../src/settings';
import { settingsSource } from '../../src/settings';
import { openDb, type Db } from '../../src/store/db';
import {
  ORGANIZATION_MIGRATION_KEY,
  migrateLegacyOrganization,
  readOrganizationMigrationReport,
} from '../../src/store/legacy-organization';
import { courses, disciplines, items, jobs, memoryStates, sessions, topics } from '../../src/store/schema';
import { resolveTopicTeaching } from '../../src/teaching';

const migrationsFolder = fileURLToPath(new URL('../../src/store/migrations', import.meta.url));
const now = new Date('2026-10-28T08:00:00Z');
let directory: string;
const opened: Db[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mini-classroom-org-migration-'));
});

afterEach(() => {
  for (const db of opened.splice(0)) {
    if (db.$client.open) db.$client.close();
  }
  rmSync(directory, { recursive: true, force: true });
});

/** 只迁移到指定版本，模拟升级前的数据库 */
function migrationsBeforeOrganization(): string {
  const folder = join(directory, 'migrations-legacy');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((entry: { tag: string }) => !entry.tag.startsWith('0009'));
  for (const entry of journal.entries) {
    copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  return folder;
}

/**
 * 旧版数据库：还没有 disciplines / courses，只有 topics.subject 与设置里的分组配置。
 * 用真实迁移目录跑到 0008，再用原始 SQL 写入旧版数据。
 */
function legacyDb(seed: (db: Db) => void): { db: Db; path: string } {
  const path = join(directory, 'legacy.sqlite');
  const db = openDb(path, migrationsBeforeOrganization());
  opened.push(db);
  seed(db);
  db.$client.close();
  return { db, path };
}

function raw(db: Db, sql: string): Record<string, unknown>[] {
  return db.$client.prepare(sql).all() as Record<string, unknown>[];
}

/** 升级：用完整迁移目录打开同一个文件 */
function upgrade(path: string): Db {
  const db = openDb(path, migrationsFolder);
  opened.push(db);
  return db;
}

function writeLegacySettings(db: Db, value: unknown): void {
  db.$client.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run('user_settings', JSON.stringify(value), now.getTime());
}

function insertTopic(db: Db, id: string, title: string, subject: string | null): void {
  db.$client
    .prepare('INSERT INTO topics (id, title, subject, status, priority, graph_status, placement_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, title, subject, 'active', 1, 'ready', 'skipped', now.getTime());
}

function insertPoint(db: Db, id: string, topicId: string, position: number): void {
  db.$client
    .prepare('INSERT INTO knowledge_points (id, topic_id, title, summary, position, origin) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, topicId, '知识点', '内容', position, 'graph');
  db.$client
    .prepare('INSERT INTO memory_states (knowledge_point_id, stage, excluded, fail_streak, pending_contrast, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'recall', 0, 0, 0, now.getTime());
}

function insertItem(db: Db, id: string, pointId: string, status: string): void {
  db.$client
    .prepare('INSERT INTO items (id, knowledge_point_id, kind, form, question_form, content, est_seconds, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, pointId, 'lesson', 'explain_direct', 'mcq', JSON.stringify({ explanation: '讲解', check: {} }), 60, status, now.getTime());
}

describe('旧版学科配置迁移', () => {
  it('分组变学科、标签变课程，主题归入课程；学习记录、候选项与任务都不改动', () => {
    const { path } = legacyDb((db) => {
      writeLegacySettings(db, {
        sessionMinutes: 15,
        subjectGroups: [
          { name: '理工科', styleId: 'stem', subjects: ['数字信号处理', '液压传动'] },
          { name: '语言', styleId: 'language', subjects: ['西班牙语'] },
        ],
        subjectStyles: { 旧标签: 'programming' },
        tagStyles: { 液压传动: 'programming' },
      });
      insertTopic(db, 'dsp', '离散时间信号', '数字信号处理');
      insertTopic(db, 'hyd', '阀控缸', '液压传动');
      insertTopic(db, 'esp', '动词变位', '西班牙语');
      insertTopic(db, 'loose', '旧主题', '旧标签');
      insertTopic(db, 'none', '未归类主题', null);
      insertPoint(db, 'p-dsp', 'dsp', 0);
      insertPoint(db, 'p-none', 'none', 0);
      insertItem(db, 'i-dsp', 'p-dsp', 'pooled');
      insertItem(db, 'i-none', 'p-none', 'pooled');
      db.$client.prepare('INSERT INTO sessions (id, started_at, budget_seconds, device) VALUES (?, ?, ?, ?)').run('s1', now.getTime(), 600, 'desktop');
      db.$client.prepare('INSERT INTO jobs (type, payload, status, tries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('fill_pool', '{}', 'pending', 0, now.getTime(), now.getTime());
    });

    const db = upgrade(path);
    const report = readOrganizationMigrationReport(db)!;
    expect(report).toMatchObject({ version: 1, topicsAssigned: 4 });
    expect(report.source).toMatchObject({ groupCount: 2, tagStyleCount: 1, legacyStyleCount: 1 });

    // 分组成为学科，风格取分组选的预设
    const dsp = db.select().from(topics).all().find((t) => t.id === 'dsp')!;
    const course = db.select().from(courses).all().find((c) => c.id === dsp.courseId)!;
    const discipline = db.select().from(disciplines).all().find((d) => d.id === course.disciplineId)!;
    expect(course.name).toBe('数字信号处理');
    expect(discipline.name).toBe('理工科');
    expect(discipline.presetId).toBe('stem');

    // 标签自己的覆盖与分组不同：单独建一个明确标识的兼容学科，保留原来的讲法
    const hyd = db.select().from(topics).all().find((t) => t.id === 'hyd')!;
    const hydCourse = db.select().from(courses).all().find((c) => c.id === hyd.courseId)!;
    const hydDiscipline = db.select().from(disciplines).all().find((d) => d.id === hydCourse.disciplineId)!;
    expect(hydDiscipline.presetId).toBe('programming');
    expect(hydDiscipline.name).toContain('独立预设');

    // 不在分组里的标签按旧扁平映射迁移
    const loose = db.select().from(topics).all().find((t) => t.id === 'loose')!;
    const looseCourse = db.select().from(courses).all().find((c) => c.id === loose.courseId)!;
    expect(db.select().from(disciplines).all().find((d) => d.id === looseCourse.disciplineId)!.presetId).toBe('programming');

    // 未归类主题保持未归类
    expect(db.select().from(topics).all().find((t) => t.id === 'none')!.courseId).toBeNull();

    // 只改组织结构：候选项仍可用、学习状态与任务都没动
    expect(db.select().from(items).all().map((i) => i.status).sort()).toEqual(['pooled', 'pooled']);
    expect(raw(db, 'SELECT stage, excluded FROM memory_states ORDER BY knowledge_point_id')).toEqual([
      { stage: 'recall', excluded: 0 },
      { stage: 'recall', excluded: 0 },
    ]);
    expect(db.select().from(sessions).all()).toHaveLength(1);
    expect(db.select().from(jobs).all()).toMatchObject([{ type: 'fill_pool', status: 'pending', tries: 0 }]);
    // 没有新增任何任务
    expect(db.select().from(jobs).all()).toHaveLength(1);
    expect(db.select().from(memoryStates).all()).toHaveLength(2);
  });

  it('多个分组包含同一标签时按第一个分组，并写进报告；重复执行不产生新记录', () => {
    const { path } = legacyDb((db) => {
      writeLegacySettings(db, {
        subjectGroups: [
          { name: '甲', styleId: 'stem', subjects: ['共用标签'] },
          { name: '乙', styleId: 'language', subjects: ['共用标签'] },
        ],
        tagStyles: {},
        subjectStyles: {},
      });
      insertTopic(db, 't', '主题', '共用标签');
    });

    const db = upgrade(path);
    const report = readOrganizationMigrationReport(db)!;
    const mapping = report.mappings.find((m) => m.tag === '共用标签')!;
    expect(db.select().from(disciplines).all().find((d) => d.id === mapping.disciplineId)!.name).toBe('甲');
    expect(report.ignored.some((i) => i.tag === '共用标签')).toBe(true);

    // 重复执行：标记与记录都在，结果不变
    const disciplinesBefore = db.select().from(disciplines).all();
    const coursesBefore = db.select().from(courses).all();
    expect(migrateLegacyOrganization(db, new Date(now.getTime() + 1000))).toBeNull();
    expect(db.select().from(disciplines).all()).toEqual(disciplinesBefore);
    expect(db.select().from(courses).all()).toEqual(coursesBefore);
    expect(db.select().from(topics).all().find((t) => t.id === 't')!.courseId).toBe(mapping.courseId);
  });

  it('保留原始配置快照：含非法值与未知字段，且不改动已存储的设置对象', () => {
    const stored = {
      sessionMinutes: 12,
      subjectGroups: [{ name: '  ', styleId: 'nope', subjects: ['x'] }],
      // 键有前后空白：按 trim 后的标签生效；值是认识的预设
      tagStyles: { '  液压传动  ': 'stem', 不认识风格: 'quantum' },
      subjectStyles: 'not-an-object',
      未来字段: { keep: true },
    };
    const { path } = legacyDb((db) => {
      writeLegacySettings(db, stored);
      insertTopic(db, 'hyd', '阀控缸', '液压传动');
      insertTopic(db, 'odd', '怪主题', '不认识风格');
    });

    const db = upgrade(path);
    const report = readOrganizationMigrationReport(db)!;
    expect(report.archived.legacy).toEqual({
      subjectGroups: stored.subjectGroups,
      tagStyles: stored.tagStyles,
      subjectStyles: stored.subjectStyles,
    });
    expect(report.archived.userSettings).toMatchObject({ 未来字段: { keep: true }, sessionMinutes: 12 });
    // 原始设置原样保留，不因迁移被清洗
    const saved = db.$client.prepare('SELECT value FROM app_settings WHERE key = ?').get('user_settings') as { value: string };
    expect(JSON.parse(saved.value)).toEqual(stored);
    // 空名分组被跳过并报告；trim 后的标签覆盖生效
    expect(report.ignored.some((i) => i.reason.includes('不认识的学科预设'))).toBe(true);
    const hyd = db.select().from(topics).all().find((t) => t.id === 'hyd')!;
    const hydCourse = db.select().from(courses).all().find((c) => c.id === hyd.courseId)!;
    expect(db.select().from(disciplines).all().find((d) => d.id === hydCourse.disciplineId)!.presetId).toBe('stem');
    // 不认识的预设按通用处理，并写进报告
    const odd = db.select().from(topics).all().find((t) => t.id === 'odd')!;
    const oddCourse = db.select().from(courses).all().find((c) => c.id === odd.courseId)!;
    expect(db.select().from(disciplines).all().find((d) => d.id === oddCourse.disciplineId)!.presetId).toBe('default');
    expect(report.ignored.some((i) => i.tag === '不认识风格')).toBe(true);
  });

  it('空库不写迁移标记：仍可导入旧版记录', () => {
    const { path } = legacyDb(() => {});
    const db = upgrade(path);
    expect(readOrganizationMigrationReport(db)).toBeNull();
    expect(raw(db, `SELECT key FROM app_settings WHERE key = '${ORGANIZATION_MIGRATION_KEY}'`)).toEqual([]);
    expect(db.select().from(disciplines).all()).toEqual([]);
  });

  it('升级后教学解析按迁移出的学科预设给引导词', () => {
    const { path } = legacyDb((db) => {
      writeLegacySettings(db, {
        subjectGroups: [{ name: '理工科', styleId: 'stem', subjects: ['数字信号处理'] }],
      });
      insertTopic(db, 'dsp', '离散信号', '数字信号处理');
    });
    const db = upgrade(path);
    const settings: Settings = settingsSource(db, {})();
    const teaching = resolveTopicTeaching(db, 'dsp', settings);
    expect(teaching).toMatchObject({ presetId: 'stem', courseId: expect.any(String), disciplineId: expect.any(String) });
    expect(teaching.guidance.tutorialGuidance).toContain('理工科');
    expect(teaching.guidance.tutorialGuidance).toContain(settings.contentGuidance.tutorialGuidance);
    expect(teaching.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });
});
