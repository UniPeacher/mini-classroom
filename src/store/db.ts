import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { migrateLegacyOrganization } from './legacy-organization';
import * as schema from './schema';

const defaultMigrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

/** 打开数据库并执行迁移；path 为 ':memory:' 时用于测试。 */
export function openDb(path: string, migrationsFolder = defaultMigrationsFolder) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });
    // 旧版学科标签与风格配置只在这里读一次原始值，转成学科/课程并留下报告。
    // 只改组织结构：不生成内容、不入队任务、不作废候选内容、不改动学习历史。
    migrateLegacyOrganization(db, new Date());
    return db;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export type Db = ReturnType<typeof openDb>;

/** 数据库或事务：数据访问函数两者都接受，便于在事务中组合调用 */
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
