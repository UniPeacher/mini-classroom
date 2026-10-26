import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAiSettings, writeAiSettings } from '../../src/ai-settings';
import { canImportDatabase, importDatabase } from '../../src/desktop/data';
import { openDb, type Db } from '../../src/store/db';
import * as schema from '../../src/store/schema';

const migrationsFolder = fileURLToPath(new URL('../../src/store/migrations', import.meta.url));
const now = new Date('2026-10-26T08:00:00Z');
let directory: string;
const connections: Database.Database[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mini-classroom-import-'));
});

afterEach(() => {
  for (const connection of connections.splice(0)) {
    if (connection.open) connection.close();
  }
  rmSync(directory, { recursive: true, force: true });
});

/** 创建测试数据库，统一在测试结束时关闭尚未关闭的连接。 */
function database(name: string, migrations = migrationsFolder): Db {
  const db = openDb(join(directory, name), migrations);
  connections.push(db.$client);
  return db;
}

/** 创建只有指定历史版本的迁移目录，用真实旧版结构验证升级。 */
function historicalMigrations(count: number): string {
  const folder = join(directory, `migrations-${count}`);
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, count);
  for (const entry of journal.entries) {
    copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  return folder;
}

/** 保存有学习状态、作答、插画和模型密钥的完整学习场景。 */
function saveLearning(db: Db): void {
  db.insert(schema.topics).values({ id: 'topic', title: '旧版学习主题', createdAt: now }).run();
  db.insert(schema.knowledgePoints).values({
    id: 'point', topicId: 'topic', title: '需要复习的知识', summary: '学习内容', position: 0,
  }).run();
  db.insert(schema.memoryStates).values({
    knowledgePointId: 'point', stage: 'recall', excluded: true, card: { due: now.toISOString() }, updatedAt: now,
  }).run();
  db.insert(schema.items).values({
    id: 'item', knowledgePointId: 'point', kind: 'lesson', form: 'analogy', questionForm: 'choice',
    content: { title: '保留原讲解', check: { answer: 'A' } }, estSeconds: 60, createdAt: now,
  }).run();
  db.insert(schema.sessions).values({ id: 'session', startedAt: now, budgetSeconds: 600 }).run();
  db.insert(schema.sessionItems).values({ sessionId: 'session', itemId: 'item', position: 0 }).run();
  db.insert(schema.attempts).values({
    id: 'attempt', itemId: 'item', sessionId: 'session', answer: { choice: 'A' }, correct: true, createdAt: now,
  }).run();
  db.insert(schema.illustrations).values({
    id: 'illustration', itemId: 'item', prompt: '保留已有插画', status: 'ready',
    image: Buffer.from([0, 10, 127, 255]), mediaType: 'image/png', createdAt: now,
  }).run();
  writeAiSettings(db, {
    text: { provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'saved-model', apiKey: 'test-saved-key' },
    image: { model: '' },
  }, now, {});
}

/** 原始行快照用于检查各类业务记录在导入后完整保留。 */
function learningRows(db: Db): Record<string, unknown[]> {
  const rows: Record<string, unknown[]> = {};
  for (const table of ['topics', 'knowledge_points', 'memory_states', 'items', 'sessions', 'session_items', 'attempts', 'illustrations', 'app_settings']) {
    rows[table] = db.$client.prepare(`SELECT * FROM ${table}`).all();
  }
  return rows;
}

describe('安装版导入资格', () => {
  it('初始空库与只有后台任务的数据库允许导入', () => {
    const db = database('target.sqlite');
    expect(canImportDatabase(db)).toBe(true);
    db.insert(schema.jobs).values({ type: 'fill_pool', payload: {}, createdAt: now, updatedAt: now }).run();
    expect(canImportDatabase(db)).toBe(true);
  });

  it.each([
    ['学习主题', (db: Db) => db.insert(schema.topics).values({ id: 'topic', title: '已有主题', createdAt: now }).run()],
    ['模型设置', (db: Db) => db.insert(schema.appSettings).values({ key: 'ai_settings', value: {}, updatedAt: now }).run()],
    ['待澄清主题', (db: Db) => db.insert(schema.topicDrafts).values({ id: 'draft', idea: '还没完成的想法', messages: [], createdAt: now, updatedAt: now }).run()],
    ['已有知识', (db: Db) => db.insert(schema.existingKnowledge).values({ id: 'known', text: '已有经验', createdAt: now }).run()],
    ['学习课程', (db: Db) => db.insert(schema.sessions).values({ id: 'session', startedAt: now, budgetSeconds: 600 }).run()],
    ['速查表', (db: Db) => db.insert(schema.cheatsheets).values({ id: 'sheet', title: '已保存速查表', scope: {}, createdAt: now }).run()],
  ])('已有%s时拒绝导入，原记录不变', async (_label, save) => {
    const source = database('source.sqlite');
    source.$client.close();
    const target = database('target.sqlite');
    save(target);
    expect(canImportDatabase(target)).toBe(false);
    target.$client.close();
    const targetPath = join(directory, 'target.sqlite');
    const before = readFileSync(targetPath);
    await expect(importDatabase(join(directory, 'source.sqlite'), targetPath)).rejects.toThrow('已有学习记录或设置');
    expect(readFileSync(targetPath)).toEqual(before);
  });
});

describe('旧版数据库导入', () => {
  it('读取未合并的 WAL，完整保留学习记录、图片和模型配置，源内容不变', async () => {
    const source = database('source.sqlite');
    source.$client.pragma('wal_autocheckpoint = 0');
    source.$client.pragma('wal_checkpoint(TRUNCATE)');
    saveLearning(source);
    const expected = learningRows(source);
    const sourcePath = join(directory, 'source.sqlite');
    expect(statSync(sourcePath + '-wal').size).toBeGreaterThan(0);
    const originalMain = readFileSync(sourcePath);
    const originalWal = readFileSync(sourcePath + '-wal');
    const target = database('target.sqlite');
    target.$client.close();

    await importDatabase(sourcePath, join(directory, 'target.sqlite'));

    expect(readFileSync(sourcePath)).toEqual(originalMain);
    expect(readFileSync(sourcePath + '-wal')).toEqual(originalWal);
    expect(learningRows(source)).toEqual(expected);
    expect(readdirSync(directory).filter((name) => name.includes('.import-'))).toEqual([]);
    const imported = database('target.sqlite');
    expect(learningRows(imported)).toEqual(expected);
    expect(readAiSettings(imported, {}).text).toMatchObject({ model: 'saved-model', apiKey: 'test-saved-key' });
    expect(canImportDatabase(imported)).toBe(false);
  });

  it('旧版结构在副本上升级，源库结构和内容保持原样', async () => {
    const source = database('source.sqlite', historicalMigrations(1));
    source.$client.prepare('INSERT INTO topics (id, title, created_at) VALUES (?, ?, ?)').run('old', '最早版本的主题', now.getTime());
    source.$client.close();
    const sourcePath = join(directory, 'source.sqlite');
    const original = readFileSync(sourcePath);
    await importDatabase(sourcePath, join(directory, 'target.sqlite'));
    expect(readFileSync(sourcePath)).toEqual(original);
    const imported = database('target.sqlite');
    // 历史主题应继续学习，不因后来加入的摸底功能重新被阻塞。
    expect(imported.select().from(schema.topics).get()).toMatchObject({ id: 'old', title: '最早版本的主题', placementStatus: 'skipped' });
    expect(imported.select().from(schema.topicDrafts).all()).toEqual([]);
  });

  it.each(['无关数据库', '未来版本', '被改写的迁移', '缺失业务表', '关联数据缺失', '不是数据库'])('%s不能破坏当前空库，并清理临时文件', async (kind) => {
    const source = database('source.sqlite');
    if (kind === '未来版本') source.$client.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('future', 9999999999999);
    if (kind === '被改写的迁移') source.$client.exec("UPDATE __drizzle_migrations SET hash = 'unknown'");
    if (kind === '缺失业务表') source.$client.exec('DROP TABLE topic_drafts');
    if (kind === '无关数据库') source.$client.exec('DROP TABLE __drizzle_migrations');
    if (kind === '关联数据缺失') {
      source.$client.pragma('foreign_keys = OFF');
      source.$client.prepare('INSERT INTO knowledge_points (id, topic_id, title, summary, position) VALUES (?, ?, ?, ?, ?)')
        .run('orphan', 'missing', '孤立知识点', '没有主题', 0);
    }
    source.$client.close();
    const sourcePath = join(directory, 'source.sqlite');
    if (kind === '不是数据库') writeFileSync(sourcePath, 'not a SQLite database');
    const originalSource = readFileSync(sourcePath);
    const target = database('target.sqlite');
    target.$client.close();
    const targetPath = join(directory, 'target.sqlite');
    const originalTarget = readFileSync(targetPath);

    await expect(importDatabase(sourcePath, targetPath)).rejects.toThrow();

    expect(readFileSync(targetPath)).toEqual(originalTarget);
    expect(readFileSync(sourcePath)).toEqual(originalSource);
    expect(readdirSync(directory).filter((name) => name.includes('.import-'))).toEqual([]);
    expect(canImportDatabase(database('target.sqlite'))).toBe(true);
  });

  it('升级中途失败时保留目标原样，删除临时库及其日志', async () => {
    const source = database('source.sqlite');
    source.$client.close();
    const target = database('target.sqlite');
    target.$client.close();
    const targetPath = join(directory, 'target.sqlite');
    const before = readFileSync(targetPath);
    const folder = historicalMigrations(100);
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries.push({ idx: 8, version: '6', when: 1999999999999, tag: '0008_failure', breakpoints: true });
    writeFileSync(journalPath, JSON.stringify(journal));
    writeFileSync(join(folder, '0008_failure.sql'), 'ALTER TABLE topics ADD COLUMN never_saved text;\n--> statement-breakpoint\nSELECT * FROM missing_table;');

    await expect(importDatabase(join(directory, 'source.sqlite'), targetPath, folder)).rejects.toThrow();

    expect(readFileSync(targetPath)).toEqual(before);
    expect(readdirSync(directory).filter((name) => name.includes('.import-'))).toEqual([]);
  });

  it('快照生成期间出现新记录时拒绝覆盖', async () => {
    const source = database('source.sqlite');
    source.$client.close();
    const target = database('target.sqlite');
    target.$client.close();
    const targetPath = join(directory, 'target.sqlite');
    const pending = importDatabase(join(directory, 'source.sqlite'), targetPath);
    const active = database('target.sqlite');
    active.insert(schema.existingKnowledge).values({ id: 'new', text: '刚保存的知识', createdAt: now }).run();
    active.$client.close();
    const before = readFileSync(targetPath);

    await expect(pending).rejects.toThrow('已有学习记录或设置');
    expect(readFileSync(targetPath)).toEqual(before);
  });

  it('目标仍在使用时拒绝导入，不删除已有 WAL', async () => {
    const source = database('source.sqlite');
    source.$client.close();
    const target = database('target.sqlite');
    const targetPath = join(directory, 'target.sqlite');
    expect(existsSync(targetPath + '-wal')).toBe(true);
    const before = readFileSync(targetPath + '-wal');
    await expect(importDatabase(join(directory, 'source.sqlite'), targetPath)).rejects.toThrow('尚未完成关闭');
    expect(readFileSync(targetPath + '-wal')).toEqual(before);
    expect(canImportDatabase(target)).toBe(true);
  });

  it('不能将当前数据库导入自身', async () => {
    const target = database('target.sqlite');
    target.$client.close();
    const targetPath = join(directory, 'target.sqlite');
    const before = readFileSync(targetPath);
    await expect(importDatabase(targetPath, targetPath)).rejects.toThrow('不能导入当前');
    expect(readFileSync(targetPath)).toEqual(before);
  });
});
