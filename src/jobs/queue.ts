import { and, asc, eq } from 'drizzle-orm';
import type { Db, Executor } from '../store/db';
import { jobs } from '../store/schema';

export type JobType = (typeof jobs.$inferSelect)['type'];
export type Job = typeof jobs.$inferSelect;

/** 单个任务最多执行几次（首次 + 重试） */
export const MAX_TRIES = 3;

/**
 * 入队一个任务。dedupe 为 true 时，若已有同类型的待执行任务就不再重复入队
 * （正在执行的不算：它开始后才产生的新需求，仍需要再跑一次）。
 */
export function enqueue(db: Executor, type: JobType, payload: unknown, now: Date, options: { dedupe?: boolean } = {}): void {
  if (options.dedupe) {
    const pending = db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.type, type), eq(jobs.status, 'pending'))).get();
    if (pending) {
      // 用最新的负载覆盖，例如更晚的"当前时间"
      db.update(jobs).set({ payload, updatedAt: now }).where(eq(jobs.id, pending.id)).run();
      return;
    }
  }
  db.insert(jobs).values({ type, payload, createdAt: now, updatedAt: now }).run();
}

/** 取出最早的待执行任务并标记为执行中。 */
export function claimNext(db: Db, now: Date): Job | undefined {
  const job = db.select().from(jobs).where(eq(jobs.status, 'pending')).orderBy(asc(jobs.id)).get();
  if (!job) return undefined;
  db.update(jobs)
    .set({ status: 'running', tries: job.tries + 1, updatedAt: now })
    .where(eq(jobs.id, job.id))
    .run();
  return { ...job, status: 'running', tries: job.tries + 1 };
}

export function complete(db: Db, id: number, now: Date): void {
  db.update(jobs).set({ status: 'done', updatedAt: now }).where(eq(jobs.id, id)).run();
}

/** 执行失败：没到上限就放回队列重试，否则标记失败。返回最终状态。 */
export function retryOrFail(db: Db, job: Job, error: unknown, now: Date): 'pending' | 'failed' {
  const status = job.tries >= MAX_TRIES ? 'failed' : 'pending';
  db.update(jobs)
    .set({ status, lastError: String(error instanceof Error ? error.message : error), updatedAt: now })
    .where(eq(jobs.id, job.id))
    .run();
  return status;
}

/** 服务启动时调用：上次进程被挂起或退出时还在执行的任务，放回队列接着执行。 */
export function resetRunning(db: Db, now: Date): void {
  db.update(jobs).set({ status: 'pending', updatedAt: now }).where(eq(jobs.status, 'running')).run();
}
