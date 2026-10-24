import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { StructuredModel, StructuredRequest } from '../../src/ai/gateway';
import { DECOMPOSE_FAIL_STREAK } from '../../src/domain/memory';
import { createApp } from '../../src/server/app';
import { createServices } from '../../src/server/services';
import { settingsSource } from '../../src/settings';
import { loadPoints, loadStates, saveState } from '../../src/store/repo';
import { attempts, jobs, memoryStates, relations } from '../../src/store/schema';
import { CORRECT_MARK, MCQ, START_MARK, createFakeModel } from '../fixtures/fake-model';
import { DAY1, createHarness } from '../fixtures/harness';

type Harness = ReturnType<typeof createHarness>;

async function started(withConnections = false) {
  const harness = createHarness();
  if (withConnections) await harness.call('POST', '/api/existing-knowledge', { text: '会写 JavaScript' });
  const topicId = await harness.startTopic();
  const session = (await harness.call('POST', '/api/sessions/next')).body.session;
  return { ...harness, topicId, session };
}

async function setExcluded(harness: Harness, pointId: string, excluded: boolean, now = DAY1) {
  const result = await harness.call('PATCH', `/api/points/${pointId}/learning`, { excluded }, now);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ id: pointId, excluded });
}

/** 让一个知识点有真实作答、评分和 FSRS 卡片，之后再测试学习偏好的切换。 */
async function learned() {
  const harness = await started();
  const item = harness.session.items[0];
  const answer = await harness.call('POST', '/api/attempts', {
    sessionId: harness.session.id,
    itemId: item.id,
    answer: { choice: MCQ.answerIndex },
  });
  expect(answer.status).toBe(201);
  expect((await harness.call('POST', `/api/attempts/${answer.body.attemptId}/rating`, { selfRating: 'good' })).status).toBe(200);
  expect((await harness.call('POST', `/api/sessions/${harness.session.id}/finish`)).status).toBe(200);
  await harness.worker.runUntilIdle();
  return { ...harness, item };
}

describe('知识点学习偏好', () => {
  it('默认参与学习，地图、详情和课堂都明确返回未排除', async () => {
    const h = await started();
    const map = (await h.call('GET', '/api/map')).body;
    expect(map.points.every((p: any) => p.excluded === false)).toBe(true);
    expect(map.topics[0]).toMatchObject({ id: h.topicId, total: 15, learned: 0, excluded: 0 });
    expect(h.session.items.every((item: any) => item.excluded === false)).toBe(true);
    expect((await h.call('GET', `/api/points/${h.session.items[0].knowledgePointId}`)).body.excluded).toBe(false);
    expect(loadPoints(h.db).every((p) => p.excluded === false)).toBe(true);
  });

  it('不学与恢复只切换持久偏好，完整保留掌握状态、FSRS 和作答留档', async () => {
    const h = await learned();
    const id = h.item.knowledgePointId;
    const beforeState = loadStates(h.db).get(id);
    const beforeUpdatedAt = h.db.select().from(memoryStates).where(eq(memoryStates.knowledgePointId, id)).get()!.updatedAt;
    const beforeDetail = (await h.call('GET', `/api/points/${id}`)).body;
    const beforeMap = (await h.call('GET', '/api/map')).body.points.find((p: any) => p.id === id);
    expect(beforeState?.stage).toBe('recall');
    expect(beforeState?.card).not.toBeNull();

    const changedAt = new Date(DAY1.getTime() + 3600 * 1000);
    await setExcluded(h, id, true, changedAt);
    await setExcluded(h, id, true, changedAt);
    expect(h.db.select().from(memoryStates).where(eq(memoryStates.knowledgePointId, id)).get()?.excluded).toBe(true);
    expect(loadPoints(h.db).find((p) => p.id === id)?.excluded).toBe(true);
    expect(loadStates(h.db).get(id)).toEqual(beforeState);
    expect(h.db.select().from(memoryStates).where(eq(memoryStates.knowledgePointId, id)).get()!.updatedAt).toEqual(beforeUpdatedAt);
    const excluded = (await h.call('GET', `/api/points/${id}`)).body;
    expect(excluded).toMatchObject({ excluded: true, stage: beforeDetail.stage, nextReviewAt: null, records: beforeDetail.records });
    const map = (await h.call('GET', '/api/map')).body;
    expect(map.points.find((p: any) => p.id === id)).toMatchObject({
      excluded: true,
      stage: beforeMap.stage,
      mastery: beforeMap.mastery,
      onEdge: false,
      fog: false,
      nextReviewAt: null,
    });
    expect(map.topics[0]).toMatchObject({ total: 15, learned: 1, excluded: 1 });

    await setExcluded(h, id, false);
    expect(loadStates(h.db).get(id)).toEqual(beforeState);
    expect((await h.call('GET', `/api/points/${id}`)).body).toEqual({ ...beforeDetail, excluded: false });
    expect(loadPoints(h.db).find((p) => p.id === id)?.excluded).toBe(false);
  });

  it('不学前置允许继续后续知识，仍保留未学统计；恢复后重新遵守前置关系', async () => {
    const h = createHarness();
    await h.startTopic();
    const points = loadPoints(h.db);
    const union = points.find((p) => p.title === '联合类型')!;
    const unknown = points.find((p) => p.title === 'unknown 类型收窄')!;
    const next = points.find((p) => p.title === '知识点 0')!;

    await setExcluded(h, union.id, true);
    let map = (await h.call('GET', '/api/map')).body;
    expect(map.points.find((p: any) => p.id === next.id)).toMatchObject({ onEdge: false, fog: true });
    await setExcluded(h, unknown.id, true);
    map = (await h.call('GET', '/api/map')).body;
    for (const id of [union.id, unknown.id]) {
      expect(map.points.find((p: any) => p.id === id)).toMatchObject({ excluded: true, stage: 'unlearned', onEdge: false, fog: false });
      expect(loadStates(h.db).get(id)?.stage).toBe('unlearned');
    }
    expect(map.points.find((p: any) => p.id === next.id)).toMatchObject({ onEdge: true, fog: false });
    expect(map.topics[0]).toMatchObject({ total: 15, learned: 0, excluded: 2 });
    await h.worker.runUntilIdle();
    const preview = (await h.call('GET', '/api/sessions/preview')).body;
    expect(preview.items.map((item: any) => item.title)).toContain(next.title);
    expect(preview.items.map((item: any) => item.title)).not.toContain(union.title);
    expect(preview.items.map((item: any) => item.title)).not.toContain(unknown.title);

    await setExcluded(h, union.id, false);
    map = (await h.call('GET', '/api/map')).body;
    expect(map.points.find((p: any) => p.id === union.id)).toMatchObject({ excluded: false, stage: 'unlearned', onEdge: true });
    expect(map.points.find((p: any) => p.id === next.id)).toMatchObject({ onEdge: false, fog: true });
    expect(map.topics[0]).toMatchObject({ total: 15, learned: 0, excluded: 1 });
  });

  it('到期的不学项不计入地图或预览复习数，恢复后按原到期日重新加入', async () => {
    const h = await learned();
    const id = h.item.knowledgePointId;
    const later = new Date('2027-06-01T09:00:00Z');
    const due = loadStates(h.db).get(id)!.card!.due;
    expect((await h.call('GET', '/api/sessions/preview', undefined, later)).body.dueCount).toBe(1);

    await setExcluded(h, id, true, later);
    expect((await h.call('GET', '/api/sessions/preview', undefined, later)).body.dueCount).toBe(0);
    expect((await h.call('GET', '/api/map', undefined, later)).body.topics[0].due).toBe(0);
    await setExcluded(h, id, false, later);
    expect(loadStates(h.db).get(id)!.card!.due).toEqual(due);
    expect((await h.call('GET', '/api/sessions/preview', undefined, later)).body.dueCount).toBe(1);
    await h.worker.runUntilIdle();
    const next = (await h.call('POST', '/api/sessions/next', undefined, later)).body.session;
    expect(next.items.find((item: any) => item.knowledgePointId === id)).toMatchObject({ excluded: false, purpose: 'review' });
  });

  it('按补充说明生成课堂期间恢复未学前置，生成结束后不再安排被前置阻挡的后续内容', async () => {
    const h = createHarness();
    await h.startTopic();
    const points = loadPoints(h.db);
    const basic = points.find((p) => p.title === '联合类型')!;
    const otherBasic = points.find((p) => p.title === 'unknown 类型收窄')!;
    const next = points.find((p) => p.title === '知识点 0')!;
    await setExcluded(h, basic.id, true);
    await setExcluded(h, otherBasic.id, true);
    await h.worker.runUntilIdle();
    expect((await h.call('GET', '/api/sessions/preview')).body.items.map((item: any) => item.title)).toContain(next.title);

    const fake = createFakeModel();
    let reached!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const model: StructuredModel = {
      async generate<T>(request: StructuredRequest<T>): Promise<T> {
        reached();
        await blocked;
        return fake.model.generate(request);
      },
    };
    const services = createServices({ db: h.db, model, settings: settingsSource(h.db, {}) });
    const app = createApp({ services, clock: () => DAY1, devMode: true });
    const pending = app.request('/api/sessions/next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guidance: '多结合例子讲解' }),
    });
    await entered;
    try {
      await setExcluded(h, basic.id, false);
    } finally {
      release();
    }

    const map = (await h.call('GET', '/api/map')).body;
    expect(map.points.find((p: any) => p.id === next.id)).toMatchObject({ stage: 'unlearned', onEdge: false, fog: true });
    const result = await (await pending).json();
    expect(result.session).not.toBeNull();
    expect(result.session.items.some((item: any) => item.knowledgePointId === next.id)).toBe(false);
    expect(result.session.items.length).toBeGreaterThan(0);
  });

  it('全部设为不学后，后台和现场构建都不再生成内容或新开空课堂', async () => {
    const h = createHarness();
    await h.startTopic();
    for (const p of loadPoints(h.db)) await setExcluded(h, p.id, true);
    const before = h.calls.length;
    await h.worker.runUntilIdle();
    const preview = (await h.call('GET', '/api/sessions/preview')).body;
    expect(preview.items).toEqual([]);
    expect(preview.dueCount).toBe(0);
    expect((await h.call('POST', '/api/sessions/next', { fresh: true })).body.session).toBeNull();
    expect(h.calls.length).toBe(before);
  });

  it('连续答错排入的拆解任务在不学期间不执行，恢复后仍会补出基础前置', async () => {
    const h = createHarness();
    await h.startTopic();
    const point = loadPoints(h.db).find((p) => p.title === '联合类型')!;
    const originalCount = loadPoints(h.db).length;
    for (let i = 0; i < DECOMPOSE_FAIL_STREAK; i += 1) {
      const session = (await h.call('POST', '/api/sessions/next')).body.session;
      const item = session.items.find((entry: any) => entry.knowledgePointId === point.id);
      expect(item).toBeDefined();
      const answer = item.question.type === 'mcq' || item.question.type === 'pick_line' ? { choice: -1 } : { text: '不记得了' };
      expect((await h.call('POST', '/api/attempts', { sessionId: session.id, itemId: item.id, answer })).body.correct).toBe(false);
      expect((await h.call('POST', `/api/sessions/${session.id}/finish`)).status).toBe(200);
      // 最后一次答错后暂停后台，让用户先把已经排入拆解的知识点设为不学。
      if (i + 1 < DECOMPOSE_FAIL_STREAK) await h.worker.runUntilIdle();
    }
    const before = loadStates(h.db).get(point.id);
    expect(before).toMatchObject({ stage: 'understand', failStreak: DECOMPOSE_FAIL_STREAK });
    const queued = h.db.select().from(jobs).all().find((job) =>
      job.type === 'decompose' && (job.payload as { knowledgePointId: string }).knowledgePointId === point.id);
    expect(queued).toMatchObject({ status: 'pending' });

    await setExcluded(h, point.id, true);
    await h.worker.runUntilIdle();
    expect(loadPoints(h.db)).toHaveLength(originalCount);
    expect(loadPoints(h.db).filter((p) => p.origin === 'decomposed')).toEqual([]);
    expect(h.db.select().from(jobs).where(eq(jobs.id, queued!.id)).get()?.status).toBe('done');
    expect(loadStates(h.db).get(point.id)).toEqual(before);

    await setExcluded(h, point.id, false);
    expect(loadStates(h.db).get(point.id)).toEqual(before);
    await h.worker.runUntilIdle();
    const updated = loadPoints(h.db);
    const basics = updated.filter((p) => p.origin === 'decomposed');
    expect(basics).toHaveLength(1);
    expect(basics[0]).toMatchObject({ title: '更基础的知识点', excluded: false });
    expect(updated.find((p) => p.id === point.id)?.prerequisiteIds).toContain(basics[0]!.id);
    expect((await h.call('GET', `/api/points/${point.id}`)).body.records).toHaveLength(DECOMPOSE_FAIL_STREAK);
  });

  it.each([undefined, {}, { excluded: 'true' }, { excluded: null }, { excluded: 1 }])('拒绝无效偏好：%j', async (body) => {
    const h = createHarness();
    await h.startTopic();
    const point = loadPoints(h.db)[0]!;
    const before = loadStates(h.db).get(point.id);
    expect((await h.call('PATCH', `/api/points/${point.id}/learning`, body)).status).toBe(400);
    expect(loadStates(h.db).get(point.id)).toEqual(before);
    expect(loadPoints(h.db).find((p) => p.id === point.id)?.excluded).toBe(false);
  });

  it('不存在的知识点返回 404', async () => {
    const h = createHarness();
    expect((await h.call('PATCH', '/api/points/no-such-point/learning', { excluded: true })).status).toBe(404);
  });
});

describe('课堂进行中切换不学', () => {
  it('同一点的讲解与联结同时标记并停止作答，恢复后原课堂可以继续', async () => {
    const h = await started(true);
    const pointId = h.session.items[0].knowledgePointId;
    const related = h.session.items.filter((item: any) => item.knowledgePointId === pointId);
    expect(related.map((item: any) => item.kind)).toEqual(['lesson', 'connection']);
    const beforeState = loadStates(h.db).get(pointId);
    await setExcluded(h, pointId, true);

    let resumed = (await h.call('POST', '/api/sessions/next')).body.session;
    expect(resumed.id).toBe(h.session.id);
    expect(resumed.items.filter((item: any) => item.knowledgePointId === pointId).every((item: any) => item.excluded && item.attempt === null)).toBe(true);
    expect(resumed.items.filter((item: any) => item.knowledgePointId !== pointId).every((item: any) => item.excluded === false)).toBe(true);
    const preview = (await h.call('GET', '/api/sessions/preview')).body;
    expect(preview.open.items.filter((item: any) => item.title === related[0].title)).toHaveLength(2);
    expect(preview.open.items.filter((item: any) => item.title === related[0].title).every((item: any) => item.excluded && item.done)).toBe(true);
    for (const item of related) {
      const answer = item.kind === 'connection' ? { text: `${CORRECT_MARK} 有关系` } : { choice: MCQ.answerIndex };
      expect((await h.call('POST', '/api/attempts', { sessionId: h.session.id, itemId: item.id, answer })).status).toBe(409);
    }
    expect(h.db.select().from(attempts).all()).toEqual([]);
    expect(loadStates(h.db).get(pointId)).toEqual(beforeState);

    await setExcluded(h, pointId, false);
    resumed = (await h.call('POST', '/api/sessions/next')).body.session;
    expect(resumed.items.filter((item: any) => item.knowledgePointId === pointId).every((item: any) => item.excluded === false)).toBe(true);
    for (const item of related) {
      const answer = item.kind === 'connection' ? { text: `${CORRECT_MARK} 有关系` } : { choice: MCQ.answerIndex };
      expect((await h.call('POST', '/api/attempts', { sessionId: h.session.id, itemId: item.id, answer })).status).toBe(201);
    }
  });

  it.each(['自评', '结束结算'])('已提交的正确答案允许完成%s，实际评分可以更新掌握但不会覆盖不学偏好', async (action) => {
    const h = await started();
    const item = h.session.items[0];
    const result = await h.call('POST', '/api/attempts', { sessionId: h.session.id, itemId: item.id, answer: { choice: MCQ.answerIndex } });
    expect(result.body.needsRating).toBe(true);
    await setExcluded(h, item.knowledgePointId, true);
    expect(loadStates(h.db).get(item.knowledgePointId)?.stage).toBe('unlearned');

    const applied = action === '自评'
      ? await h.call('POST', `/api/attempts/${result.body.attemptId}/rating`, { selfRating: 'good' })
      : await h.call('POST', `/api/sessions/${h.session.id}/finish`);
    expect(applied.status).toBe(200);
    expect(loadStates(h.db).get(item.knowledgePointId)?.stage).toBe('recall');
    const detail = (await h.call('GET', `/api/points/${item.knowledgePointId}`)).body;
    expect(detail).toMatchObject({ excluded: true, stage: 'recall', nextReviewAt: null });
    expect(detail.records).toHaveLength(1);
    expect(detail.records[0]).toMatchObject({ correct: true, selfRating: 'good' });
    expect(loadPoints(h.db).find((p) => p.id === item.knowledgePointId)?.excluded).toBe(true);
  });

  it.each(['grade', 'connection_grade'])('模型 %s 批改期间设为不学，迟到的结果返回冲突且不写作答或联结', async (name) => {
    const h = await started(true);
    const item = h.session.items.find((entry: any) => name === 'grade' ? entry.question?.type === 'short_answer' : entry.kind === 'connection');
    expect(item).toBeDefined();
    const before = loadStates(h.db);
    const fake = createFakeModel();
    let reached!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const model: StructuredModel = {
      async generate<T>(request: StructuredRequest<T>): Promise<T> {
        if (request.name === name) {
          reached();
          await blocked;
        }
        return fake.model.generate(request);
      },
    };
    const services = createServices({ db: h.db, model, settings: settingsSource(h.db, {}) });
    const app = createApp({ services, clock: () => DAY1, devMode: true });
    const pending = app.request('/api/attempts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: h.session.id, itemId: item.id, answer: { text: name === 'grade' ? '不记得了' : `${CORRECT_MARK} 有关系` } }),
    });
    await entered;
    try {
      await setExcluded(h, item.knowledgePointId, true);
    } finally {
      release();
    }
    expect((await pending).status).toBe(409);
    expect(h.db.select().from(attempts).all()).toEqual([]);
    expect(loadStates(h.db)).toEqual(before);
    expect((await h.call('GET', '/api/map')).body.connections).toEqual([]);
  });
});

describe('不学知识在组块中可见', () => {
  it.each(['部分', '整体'])('组成关系的%s设为不学时，不会被组块折叠隐藏', async (target) => {
    const h = createHarness();
    await h.startTopic();
    const [part1, part2, whole] = loadPoints(h.db);
    for (const part of [part1!, part2!]) {
      saveState(h.db, part.id, { ...loadStates(h.db).get(part.id)!, stage: 'retain' }, DAY1);
      h.db.insert(relations).values({ fromId: part.id, toId: whole!.id, type: 'composition' }).run();
    }
    expect((await h.call('GET', '/api/map')).body.chunks).toEqual([{ wholeId: whole!.id, partIds: [part1!.id, part2!.id] }]);
    const id = target === '部分' ? part1!.id : whole!.id;
    await setExcluded(h, id, true);
    const map = (await h.call('GET', '/api/map')).body;
    expect(map.points.find((p: any) => p.id === id)?.excluded).toBe(true);
    expect(map.chunks).toEqual([]);
  });
});

describe('摸底诊断尊重不学偏好', () => {
  it('答对后续内容不会把不学的前置推断为掌握', async () => {
    const h = createHarness();
    const topicId = await h.startTopic('TypeScript 常用技能', { skipPlacement: false });
    const path = `/api/topics/${topicId}/placement`;
    await h.call('POST', path, { background: `写过 JavaScript ${START_MARK}` });
    await h.worker.runUntilIdle();
    const points = loadPoints(h.db);
    const excluded = points.find((p) => p.title === '联合类型')!;
    const included = points.find((p) => p.title === 'unknown 类型收窄')!;
    await setExcluded(h, excluded.id, true);

    let placement = (await h.call('GET', path)).body;
    expect(placement.question.title).toBe('知识点 0');
    placement = (await h.call('POST', `${path}/answer`, { pointId: placement.question.pointId, choice: MCQ.answerIndex })).body;
    for (let i = 0; placement.status === 'testing' && i < 10; i += 1) {
      expect(placement.question.pointId).not.toBe(excluded.id);
      placement = (await h.call('POST', `${path}/answer`, { pointId: placement.question.pointId, choice: -1 })).body;
    }

    expect(placement).toMatchObject({ status: 'done', question: null, summary: { correct: 1, inferred: 1, unknown: 12 } });
    expect(loadStates(h.db).get(excluded.id)?.stage).toBe('unlearned');
    expect(loadPoints(h.db).find((p) => p.id === excluded.id)?.excluded).toBe(true);
    expect(loadStates(h.db).get(included.id)?.stage).toBe('inferred');
  });

  it('当前摸底题设为不学后拒绝旧答案，全部不学时结束诊断而不卡在空题目', async () => {
    const h = createHarness();
    const topicId = await h.startTopic('TypeScript 常用技能', { skipPlacement: false });
    const path = `/api/topics/${topicId}/placement`;
    await h.call('POST', path, { background: '' });
    await h.worker.runUntilIdle();
    const before = loadStates(h.db);
    const current = (await h.call('GET', path)).body.question;
    await setExcluded(h, current.pointId, true);
    expect((await h.call('POST', `${path}/answer`, { pointId: current.pointId, choice: MCQ.answerIndex })).status).toBe(409);
    expect((await h.call('GET', path)).body.question.pointId).not.toBe(current.pointId);

    for (const point of loadPoints(h.db).filter((p) => !p.excluded)) await setExcluded(h, point.id, true);
    expect((await h.call('GET', path)).body).toMatchObject({ status: 'done', question: null, summary: { correct: 0, inferred: 0, unknown: 0 } });
    expect(loadStates(h.db)).toEqual(before);
    await h.worker.runUntilIdle();
    expect((await h.call('POST', '/api/sessions/next')).body.session).toBeNull();
  });
});
