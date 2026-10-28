import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/store/db';

const sourceDirectory = process.argv[2];
if (!sourceDirectory) throw new Error('请传入已关闭应用后取得的完整 data 备份目录，不要传入正在使用的数据目录。');
const directory = resolve(sourceDirectory);
const name = 'weiketang.sqlite';
assert.ok(existsSync(join(directory, name)), '备份目录中没有 weiketang.sqlite');
const temporary = mkdtempSync(join(tmpdir(), 'mini-classroom-upgrade-copy-'));
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sourceHashes = new Map(readdirSync(directory).filter((file) => file.startsWith(name)).map((file) => [file, hash(join(directory, file))]));

interface Snapshot {
  table: string;
  columns: string[];
  rows: string[];
}
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
function snapshot(db: Database.Database, table: string, columns?: string[]): Snapshot {
  const fields = columns ?? (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[]).map((row) => row.name);
  const rows = db.prepare(`SELECT ${fields.map(quote).join(', ')} FROM ${quote(table)}`).all();
  return { table, columns: fields, rows: rows.map((row) => JSON.stringify(row)).sort() };
}

try {
  for (const extension of ['', '-wal', '-shm']) {
    const source = join(directory, `${name}${extension}`);
    if (existsSync(source)) copyFileSync(source, join(temporary, `${name}${extension}`));
  }
  const path = join(temporary, name);
  const before = new Database(path);
  const names = (before.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((row) => row.name).filter((table) => table !== '__drizzle_migrations');
  const snapshots = names.filter((table) => table !== 'app_settings').map((table) => snapshot(before, table));
  const oldSettings = before.prepare("SELECT value FROM app_settings WHERE key='user_settings'").get() as { value: string } | undefined;
  before.close();

  const upgraded = openDb(path);
  for (const old of snapshots) {
    assert.deepEqual(snapshot(upgraded.$client, old.table, old.columns).rows, old.rows, `${old.table} 原有数据被改写`);
  }
  const newSettings = upgraded.$client.prepare("SELECT value FROM app_settings WHERE key='user_settings'").get() as { value: string } | undefined;
  assert.deepEqual(newSettings, oldSettings, '原始用户设置快照发生变化');
  const counts = upgraded.$client.prepare(`SELECT
    (SELECT count(*) FROM topics) AS topics,
    (SELECT count(*) FROM knowledge_points) AS points,
    (SELECT count(*) FROM attempts) AS attempts,
    (SELECT count(*) FROM disciplines) AS disciplines,
    (SELECT count(*) FROM courses) AS courses`).get();
  const report = upgraded.$client.prepare("SELECT value FROM app_settings WHERE key='organization_migration_v1'").get() as { value: string } | undefined;
  const mapped = report ? JSON.parse(report.value).report : null;
  upgraded.$client.close();

  const second = openDb(path);
  for (const old of snapshots) assert.deepEqual(snapshot(second.$client, old.table, old.columns).rows, old.rows, `${old.table} 重启后数据变化`);
  second.$client.close();
  for (const [file, sha] of sourceHashes) assert.equal(hash(join(directory, file)), sha, '备份源文件被改变');
  console.log(JSON.stringify({ passed: true, originalColumnsUnchanged: snapshots.map((s) => s.table), counts,
    migration: mapped ? { topicsAssigned: mapped.topicsAssigned, created: mapped.created, warnings: mapped.ignored?.length ?? 0 } : null,
    originalSettingsUnchanged: true, sourceFilesUnchanged: true, secondStartupPassed: true }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
