import type { Illustrator } from '../../src/ai/gateway';
import { createHandlers } from '../../src/jobs/handlers';
import { createWorker } from '../../src/jobs/worker';
import { createApp } from '../../src/server/app';
import { createServices } from '../../src/server/services';
import { settingsSource } from '../../src/settings';
import { openDb } from '../../src/store/db';
import { type FakeModelOptions, createFakeModel } from './fake-model';

export const DAY1 = new Date('2026-10-20T09:00:00Z');
export const DAY = 24 * 3600 * 1000;

/** 用内存数据库 + 假模型组装出完整应用，时间由每个请求的 X-Dev-Now 决定。传入 illustrator 时讲解可配插画。 */
export function createHarness(options: FakeModelOptions & { illustrator?: Illustrator } = {}) {
  const { illustrator } = options;
  const db = openDb(':memory:');
  const { model, calls, prompts, requests } = createFakeModel(options);
  // 测试不受本机环境变量影响：设置只来自数据库和默认值
  const settings = settingsSource(db, {});
  const clock = () => DAY1;
  const worker = createWorker(db, createHandlers({ db, model, clock, settings, illustrator: () => illustrator }), clock);
  const services = createServices({ db, model, settings, illustrator: () => illustrator });
  const app = createApp({ services, clock, devMode: true });

  async function call<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, now: Date = DAY1) {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Dev-Now': now.toISOString() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  /** 新建主题、生成图谱；默认跳过摸底诊断（所有知识点从未学开始），并备好候选池 */
  async function startTopic(title = 'TypeScript 常用技能', { skipPlacement = true, now = DAY1 } = {}) {
    const { topicId } = (await call('POST', '/api/topics', { title }, now)).body;
    await worker.runUntilIdle();
    if (skipPlacement) {
      await call('POST', `/api/topics/${topicId}/placement/skip`, undefined, now);
      await worker.runUntilIdle();
    }
    return topicId as string;
  }

  return { db, app, services, worker, model, calls, prompts, requests, call, startTopic };
}
