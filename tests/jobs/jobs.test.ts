import { describe, expect, it } from 'vitest';
import { createHandlers } from '../../src/jobs/handlers';
import { claimNext, enqueue } from '../../src/jobs/queue';
import { createWorker } from '../../src/jobs/worker';
import { openDb } from '../../src/store/db';
import { createTopic, getTopic, loadPoints, loadPool, loadStates } from '../../src/store/repo';
import { DEFAULT_USER_SETTINGS, toSettings } from '../../src/settings';
import { jobs, topics } from '../../src/store/schema';
import { type FakeModelOptions, createFakeModel } from '../fixtures/fake-model';

const now = new Date('2026-10-20T12:00:00Z');
const settings = () => ({ ...toSettings(DEFAULT_USER_SETTINGS, {}), generationConcurrency: 2 });

function setup(options: FakeModelOptions = {}) {
  const db = openDb(':memory:');
  const { model, calls } = createFakeModel(options);
  const worker = createWorker(db, createHandlers({ db, model, clock: () => now, settings }), () => now);
  const topicId = createTopic(db, 'TypeScript 常用技能', now);
  // 跳过摸底诊断：所有知识点从未学开始，可以新学
  db.update(topics).set({ placementStatus: 'skipped' }).run();
  enqueue(db, 'generate_graph', { topicId }, now);
  return { db, worker, topicId, calls };
}

describe('后台任务：新建主题后', () => {
  it('生成图谱，所有知识点从"未学"开始，并接着补满候选池', async () => {
    const { db, worker, topicId } = setup();
    await worker.runUntilIdle();

    expect(getTopic(db, topicId)?.graphStatus).toBe('ready');
    const points = loadPoints(db);
    expect(points).toHaveLength(15);
    expect([...loadStates(db).values()].every((s) => s.stage === 'unlearned')).toBe(true);

    // 两节 × 每节最多 2 个新知识点 = 4 项讲解，来自认知边缘
    const pool = loadPool(db);
    expect(pool).toHaveLength(4);
    expect(pool.every((i) => i.kind === 'lesson')).toBe(true);
    const unlocked = points.filter((p) => p.prerequisiteIds.length === 0).map((p) => p.id);
    expect(pool.every((i) => unlocked.includes(i.knowledgePointId))).toBe(true);
  });

  it('前置关系与易混关系按知识点还原', async () => {
    const { db, worker } = setup();
    await worker.runUntilIdle();
    const points = loadPoints(db);
    const byTitle = (t: string) => points.find((p) => p.title === t)!;
    expect(byTitle('知识点 0').prerequisiteIds.sort()).toEqual([byTitle('联合类型').id, byTitle('unknown 类型收窄').id].sort());
    expect(byTitle('联合类型').confusableIds).toEqual([byTitle('unknown 类型收窄').id]);
  });

  it('图谱结构始终不合法时，主题标记为失败，不再重试', async () => {
    const { db, worker, topicId, calls } = setup({ invalid: ['knowledge_graph'] });
    await worker.runUntilIdle();
    expect(getTopic(db, topicId)?.graphStatus).toBe('failed');
    expect(calls.filter((c) => c === 'knowledge_graph')).toHaveLength(1);
  });

  it('网络错误时重试，恢复后照常完成', async () => {
    const { db, worker, topicId } = setup({ networkFailures: { knowledge_graph: 2 } });
    await worker.runUntilIdle();
    expect(getTopic(db, topicId)?.graphStatus).toBe('ready');
  });

  it('网络错误重试用尽后放弃，主题标记为失败', async () => {
    const { db, worker, topicId } = setup({ networkFailures: { knowledge_graph: 5 } });
    await worker.runUntilIdle();
    expect(getTopic(db, topicId)?.graphStatus).toBe('failed');
    expect(db.select().from(jobs).all().find((j) => j.type === 'generate_graph')?.status).toBe('failed');
  });

  it('某项内容结构始终不合法时丢弃该项，其余照常生成', async () => {
    const { db, worker } = setup({ invalid: ['lesson'] });
    await worker.runUntilIdle();
    expect(loadPool(db)).toHaveLength(0);
    expect(db.select().from(jobs).all().every((j) => j.status === 'done')).toBe(true);
  });
});

describe('后台任务：并发生成候选池', () => {
  it('按配置的并发数同时生成，不超过上限', async () => {
    const db = openDb(':memory:');
    const { model, concurrency } = createFakeModel({ delayMs: 20 });
    const worker = createWorker(db, createHandlers({ db, model, clock: () => now, settings }), () => now);
    enqueue(db, 'generate_graph', { topicId: createTopic(db, 'TypeScript 常用技能', now) }, now);
    db.update(topics).set({ placementStatus: 'skipped' }).run();
    await worker.runUntilIdle();
    expect(loadPool(db)).toHaveLength(4);
    expect(concurrency.peak).toBe(settings().generationConcurrency);
  });

  it('其中一项遇到网络错误时，其余照常入池；重试时只补缺少的那一项', async () => {
    const { db, worker, calls } = setup({ networkFailures: { lesson: 1 } });
    await worker.runUntilIdle();
    expect(loadPool(db)).toHaveLength(4);
    // 第一轮 4 次（1 次失败）+ 重试只补 1 次
    expect(calls.filter((c) => c === 'lesson')).toHaveLength(5);
  });
});

describe('后台任务：可续跑', () => {
  it('进程中断时仍在执行的任务，重启后接着执行', async () => {
    const { db, worker, topicId } = setup();
    claimNext(db, now); // 模拟：任务刚开始执行，进程就被挂起
    expect(await worker.runOnce()).toBe(false); // 没有待执行的任务

    worker.start(10);
    await new Promise((resolve) => setTimeout(resolve, 50));
    worker.stop();
    expect(getTopic(db, topicId)?.graphStatus).toBe('ready');
  });

  it('补候选池的任务去重：已有待执行的就不再重复入队', () => {
    const db = openDb(':memory:');
    enqueue(db, 'fill_pool', {}, now, { dedupe: true });
    enqueue(db, 'fill_pool', { now: '2026-10-21T12:00:00.000Z' }, now, { dedupe: true });
    const rows = db.select().from(jobs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ now: '2026-10-21T12:00:00.000Z' });
  });
});
