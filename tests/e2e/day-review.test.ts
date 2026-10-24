import { describe, expect, it } from 'vitest';
import { MCQ } from '../fixtures/fake-model';
import { DAY, createHarness } from '../fixtures/harness';

// 北京时间 10 月 21 日凌晨 4 点，UTC 还是 10 月 20 日：用来检验"哪一天"按用户时区划分
const LATE_NIGHT = new Date('2026-10-20T20:00:00Z');
const NEXT_DAY = new Date(LATE_NIGHT.getTime() + DAY);

/**
 * 按天回看：列出有学习记录的日子，选一天重读那天的讲解和作答。
 * 第 1 节在 LATE_NIGHT 学两个知识点（答对一个、答错一个），第 2 节在一天后。
 */
async function twoDaysLearned() {
  const harness = createHarness();
  const { call, worker } = harness;
  const topicId = await harness.startTopic('TypeScript 常用技能', { now: LATE_NIGHT });

  const answerAll = async (now: Date) => {
    const session = (await call('POST', '/api/sessions/next', undefined, now)).body.session;
    for (const item of session.items) {
      const answer = item.question.type === 'mcq' ? { choice: MCQ.answerIndex } : { text: '不记得了' };
      await call('POST', '/api/attempts', { sessionId: session.id, itemId: item.id, answer }, now);
    }
    await call('POST', `/api/sessions/${session.id}/finish`, undefined, now);
    await worker.runUntilIdle();
    return session;
  };
  const first = await answerAll(LATE_NIGHT);
  const second = await answerAll(NEXT_DAY);
  // 学完之后才新建的主题，没有任何学习记录
  const other = await harness.startTopic('没学过的主题', { now: NEXT_DAY });
  return { ...harness, topicId, other, first, second };
}

const query = (params: Record<string, string>) => `?${new URLSearchParams(params)}`;

describe('按天回看：有学习记录的日子', () => {
  it('按用户时区划分日期，最近的在前，并给出当天学过几个知识点', async () => {
    const { call, first } = await twoDaysLearned();
    const utc = (await call('GET', `/api/review-days${query({ timeZone: 'UTC' })}`)).body.days;
    expect(utc.map((d: any) => d.day)).toEqual(['2026-10-21', '2026-10-20']);
    expect(utc[1].pointCount).toBe(first.items.length);

    const beijing = (await call('GET', `/api/review-days${query({ timeZone: 'Asia/Shanghai' })}`)).body.days;
    expect(beijing.map((d: any) => d.day)).toEqual(['2026-10-22', '2026-10-21']);
  });

  it('指定主题时只算这个主题；没学过的主题没有日子', async () => {
    const { call, topicId, other } = await twoDaysLearned();
    expect((await call('GET', `/api/review-days${query({ timeZone: 'UTC', topicId })}`)).body.days).toHaveLength(2);
    expect((await call('GET', `/api/review-days${query({ timeZone: 'UTC', topicId: other })}`)).body.days).toEqual([]);
  });

  it('时区不合法返回 400，主题不存在返回 404', async () => {
    const { call } = createHarness();
    expect((await call('GET', `/api/review-days${query({ timeZone: 'Mars/Base' })}`)).status).toBe(400);
    expect((await call('GET', `/api/review-days${query({ timeZone: 'UTC', topicId: 'nope' })}`)).status).toBe(404);
  });
});

describe('按天回看：那一天的内容', () => {
  it('按当时顺序给出那天的讲解、题目（含答案）、回答和批改，并带上主题与知识点', async () => {
    const { call, first } = await twoDaysLearned();
    const review = (await call('GET', `/api/review-days/2026-10-21${query({ timeZone: 'Asia/Shanghai' })}`)).body;
    expect(review.topic).toBeNull();
    expect(review.entries.map((e: any) => e.record.attemptId)).toHaveLength(first.items.length);
    expect(review.entries.map((e: any) => e.point.title)).toEqual(first.items.map((i: any) => i.title));

    const [union, unknown] = review.entries;
    expect(union).toMatchObject({ topicTitle: 'TypeScript 常用技能', point: { stage: 'recall' } });
    expect(union.record).toMatchObject({ kind: 'lesson', correct: true, question: { answerIndex: MCQ.answerIndex } });
    expect(union.record.explanation).toEqual(expect.any(String));
    // 记录是当天的（答错），阶段是现在的：第 2 节重讲后答对，已进入回忆阶段
    expect(unknown).toMatchObject({ point: { stage: 'recall' }, record: { correct: false } });
    expect(unknown.record.question).toHaveProperty('referenceAnswer');
  });

  it('同一时刻在不同时区属于不同的一天', async () => {
    const { call } = await twoDaysLearned();
    const utcDay = (await call('GET', `/api/review-days/2026-10-21${query({ timeZone: 'UTC' })}`)).body.entries;
    const beijingDay = (await call('GET', `/api/review-days/2026-10-21${query({ timeZone: 'Asia/Shanghai' })}`)).body.entries;
    // UTC 的 10-21 是第 2 节，北京时间的 10-21 是第 1 节
    expect(utcDay[0].record.at).toBe(NEXT_DAY.toISOString());
    expect(beijingDay[0].record.at).toBe(LATE_NIGHT.toISOString());
  });

  it('指定主题时只给这个主题的内容；没学习的日子为空；日期格式不对返回 400', async () => {
    const { call, topicId, other } = await twoDaysLearned();
    const own = (await call('GET', `/api/review-days/2026-10-20${query({ timeZone: 'UTC', topicId })}`)).body;
    expect(own.topic.title).toBe('TypeScript 常用技能');
    expect(own.entries.length).toBeGreaterThan(0);
    expect((await call('GET', `/api/review-days/2026-10-20${query({ timeZone: 'UTC', topicId: other })}`)).body.entries).toEqual([]);
    expect((await call('GET', `/api/review-days/2026-01-01${query({ timeZone: 'UTC' })}`)).body.entries).toEqual([]);
    expect((await call('GET', `/api/review-days/20261020${query({ timeZone: 'UTC' })}`)).status).toBe(400);
  });
});
