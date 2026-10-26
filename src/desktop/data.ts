import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import { openDb, type Db } from '../store/db';

const defaultMigrationsFolder = fileURLToPath(new URL('../store/migrations', import.meta.url));
const migrationTable = '__drizzle_migrations';

/** 将数据库里的表名作为 SQL 标识符使用，避免名称被解释成 SQL。 */
function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** 列出应用的业务表，忽略 SQLite 自身维护的表。 */
function businessTables(sqlite: Database.Database): string[] {
  const rows = sqlite.prepare<[], { name: string }>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
  ).all();
  return rows.map((row) => row.name).filter((name) => !name.startsWith('sqlite_') && name !== migrationTable);
}

/** 判断是否已有用户记录；只有后台任务不构成用户数据。 */
function hasUserData(sqlite: Database.Database): boolean {
  for (const table of businessTables(sqlite)) {
    if (table === 'jobs') continue;
    if (sqlite.prepare(`SELECT 1 FROM ${identifier(table)} LIMIT 1`).get()) return true;
  }
  return false;
}

/**
 * 判断安装版是否仍可导入旧版记录。
 *
 * 学习记录、模型设置、未确认的主题和其他用户内容都会阻止替换。
 *
 * Args:
 *   db: 已打开的安装版数据库。
 *
 * Returns:
 *   除后台任务外没有任何业务记录时返回 true。
 */
export function canImportDatabase(db: Db): boolean {
  return !hasUserData(db.$client);
}

/** 确认迁移历史是本应用支持的连续前缀，拒绝不相关或更新版本的数据库。 */
function validateHistory(sqlite: Database.Database, migrations: MigrationMeta[]): void {
  const hasHistory = sqlite.prepare('SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?')
    .get('table', migrationTable);
  if (!hasHistory) throw new Error('所选文件不是可识别的微课堂数据库。');

  const history = sqlite.prepare<[], { hash: string; created_at: number }>(
    `SELECT hash, created_at FROM ${identifier(migrationTable)} ORDER BY created_at`,
  ).all();
  if (history.length === 0) throw new Error('所选数据库没有微课堂的版本记录。');
  for (const [index, entry] of history.entries()) {
    const expected = migrations[index];
    if (!expected || entry.hash !== expected.hash || entry.created_at !== expected.folderMillis) {
      throw new Error('所选数据库版本不受当前安装版支持，请先升级微课堂。');
    }
  }
}

/** 在临时库升级后核对表结构和关联完整性，损坏的文件不能替换当前记录。 */
function validateDatabase(sqlite: Database.Database, expected: Database.Database): void {
  const tables = businessTables(sqlite);
  if (JSON.stringify(tables) !== JSON.stringify(businessTables(expected))) {
    throw new Error('所选数据库的学习记录结构不完整或不受支持。');
  }
  for (const table of tables) {
    for (const pragma of ['table_info', 'foreign_key_list']) {
      const statement = `${pragma}(${identifier(table)})`;
      if (JSON.stringify(sqlite.pragma(statement)) !== JSON.stringify(expected.pragma(statement))) {
        throw new Error('所选数据库的学习记录结构不完整或不受支持。');
      }
    }
  }
  const extraObjects = sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('view', 'trigger') LIMIT 1").get();
  if (extraObjects) throw new Error('所选数据库包含当前微课堂不支持的结构。');
  if (sqlite.pragma('quick_check', { simple: true }) !== 'ok') {
    throw new Error('所选数据库已经损坏，无法导入。');
  }
  if ((sqlite.pragma('foreign_key_check') as unknown[]).length > 0) {
    throw new Error('所选数据库存在缺失的关联记录，无法导入。');
  }
}

/** 确认目标已关闭，避免将旧日志应用到新导入的数据库。 */
function assertClosedTarget(targetPath: string): void {
  if (['-wal', '-shm', '-journal'].some((suffix) => existsSync(targetPath + suffix))) {
    throw new Error('当前数据库仍在使用或尚未完成关闭，请重启微课堂后再导入。');
  }
}

/** 只读检查目标；删除本次检查创建的空日志，不处理任何已有日志。 */
function assertReplaceableTarget(targetPath: string, migrations: MigrationMeta[]): void {
  assertClosedTarget(targetPath);
  if (!existsSync(targetPath)) return;
  const sqlite = new Database(targetPath, { readonly: true, fileMustExist: true });
  try {
    validateHistory(sqlite, migrations);
    if (hasUserData(sqlite)) throw new Error('当前安装版已有学习记录或设置，不能覆盖导入。');
  } finally {
    sqlite.close();
    const walPath = targetPath + '-wal';
    if (existsSync(walPath) && statSync(walPath).size === 0) {
      rmSync(walPath);
      rmSync(targetPath + '-shm', { force: true });
    }
  }
  assertClosedTarget(targetPath);
}

/**
 * 将用户选择的旧版微课堂数据库导入尚未使用的安装版。
 *
 * 调用方须先关闭目标数据库及其后台任务。源库始终只读，通过 SQLite
 * backup 读取包含 WAL 的一致快照；校验和升级完成后才原子替换目标。
 *
 * Args:
 *   sourcePath: 用户明确选择的旧版数据库路径。
 *   targetPath: 安装版数据库路径；不能包含已有用户数据。
 *   migrationsFolder: 安装版附带的迁移目录，默认使用源码中的目录。
 *
 * Returns:
 *   导入完成后的 Promise；校验或升级失败时目标内容保持原样。
 */
export async function importDatabase(
  sourcePath: string,
  targetPath: string,
  migrationsFolder = defaultMigrationsFolder,
): Promise<void> {
  const sourceStat = statSync(sourcePath);
  if (existsSync(targetPath)) {
    const targetStat = statSync(targetPath);
    if (realpathSync(sourcePath) === realpathSync(targetPath)
      || (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)) {
      throw new Error('请选择旧版数据库，不能导入当前正在使用的数据库。');
    }
  }

  const migrations = readMigrationFiles({ migrationsFolder });
  assertReplaceableTarget(targetPath, migrations);
  mkdirSync(dirname(targetPath), { recursive: true });
  const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.import-${randomUUID()}`);
  closeSync(openSync(temporaryPath, 'wx', 0o600));
  try {
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      validateHistory(source, migrations);
      await source.backup(temporaryPath);
    } finally {
      source.close();
    }

    const imported = openDb(temporaryPath, migrationsFolder);
    try {
      const expected = openDb(':memory:', migrationsFolder);
      try {
        validateHistory(imported.$client, migrations);
        validateDatabase(imported.$client, expected.$client);
      } finally {
        expected.$client.close();
      }
      // 将快照中的日志合并到主文件，确保原子替换只涉及一个完整文件。
      imported.$client.pragma('journal_mode = DELETE');
    } finally {
      imported.$client.close();
    }

    // backup 会异步让出执行权，替换前必须重新确认没有新增用户记录。
    assertReplaceableTarget(targetPath, migrations);
    renameSync(temporaryPath, targetPath);
  } finally {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(temporaryPath + suffix, { force: true });
    }
  }
}
