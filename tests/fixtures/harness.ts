import { createHandlers } from '../../src/jobs/handlers';
import { createWorker } from '../../src/jobs/worker';
import { createApp } from '../../src/server/app';
import { createLearning } from '../../src/server/learning';
import { openDb } from '../../src/store/db';
import { type FakeModelOptions, createFakeModel } from './fake-model';

export const DAY1 = new Date('2026-10-20T09:00:00Z');
export const DAY = 24 * 3600 * 1000;

/** 用内存数据库 + 假模型组装出完整应用，时间由每个请求的 X-Dev-Now 决定。 */
export function createHarness(options: FakeModelOptions = {}) {
  const db = openDb(':memory:');
  const { model, calls } = createFakeModel(options);
  const settings = { budgetSeconds: 600, maxNewPerSession: 2, generationConcurrency: 3 };
  const clock = () => DAY1;
  const worker = createWorker(db, createHandlers({ db, model, clock, settings }), clock);
  const app = createApp({ learning: createLearning({ db, model, settings }), clock, devMode: true });

  async function call<T = any>(method: 'GET' | 'POST', path: string, body?: unknown, now: Date = DAY1) {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Dev-Now': now.toISOString() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  return { db, app, worker, calls, call };
}
