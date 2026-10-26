import type { Db } from '../store/db';
import { type JobType, claimNext, complete, resetRunning, retryOrFail } from './queue';

export interface JobHandler {
  run(payload: unknown): Promise<void>;
  /** 重试用尽、最终放弃时调用 */
  onGiveUp?(payload: unknown, error: unknown): void;
}

export type JobHandlers = Record<JobType, JobHandler>;

/** 进程内的后台任务执行器：一次只执行一个任务。 */
export function createWorker(db: Db, handlers: JobHandlers, clock: () => Date) {
  let timer: NodeJS.Timeout | undefined;
  let activeRun: Promise<void> | undefined;
  let stopped = false;

  /** 执行一个任务；队列为空时返回 false。 */
  async function runOnce(): Promise<boolean> {
    const job = claimNext(db, clock());
    if (!job) return false;
    const handler = handlers[job.type];
    try {
      await handler.run(job.payload);
      complete(db, job.id, clock());
    } catch (error) {
      console.error(`后台任务 ${job.type}#${job.id} 第 ${job.tries} 次执行失败：`, error);
      if (retryOrFail(db, job, error, clock()) === 'failed') handler.onGiveUp?.(job.payload, error);
    }
    return true;
  }

  /** 一直执行到队列为空（测试和启动续跑时使用）。 */
  async function runUntilIdle(): Promise<void> {
    while (!stopped && await runOnce());
  }

  /** 启动轮询；先把上次中断的任务放回队列。 */
  function start(intervalMs = 1000): void {
    if (activeRun || timer) return;
    resetRunning(db, clock());
    stopped = false;
    const tick = async () => {
      timer = undefined;
      activeRun = runUntilIdle();
      try {
        await activeRun;
      } catch (error) {
        console.error('后台任务执行器失败：', error);
      } finally {
        activeRun = undefined;
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    void tick();
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    await activeRun;
  }

  return { runOnce, runUntilIdle, start, stop };
}

export type Worker = ReturnType<typeof createWorker>;
